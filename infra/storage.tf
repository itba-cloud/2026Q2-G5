data "aws_partition" "current" {}

locals {
  account_id            = data.aws_caller_identity.current.account_id
  snapshot_bucket_name  = "${var.project_name}-snapshots-${local.account_id}"
  client_bucket_name    = "${var.project_name}-client-${local.account_id}"
  artifacts_bucket_name = "${var.project_name}-artifacts-${local.account_id}"
  client_source_dir     = "${path.module}/../client"
  client_files = toset([
    for file in fileset(local.client_source_dir, "**") : file
    if file != "runtime-config.js" && file != "server.js" && !startswith(file, "tests/")
  ])
  runtime_config_js = "window.ELASTIC_WORLDS_RUNTIME_CONFIG = Object.freeze(${jsonencode({
    lobbyApiUrl   = "http://${aws_lb.main.dns_name}"
    metricsApiUrl = "http://${aws_lb.main.dns_name}"
  })});\n"
  client_content_types = {
    css  = "text/css"
    html = "text/html"
    js   = "application/javascript"
    json = "application/json"
    png  = "image/png"
    svg  = "image/svg+xml"
  }
}

# Creados por el bootstrap opcional de Terraform o bootstrap-buckets.sh:
# el SCP del Learner Lab
# deniega s3:GetBucketObjectLockConfiguration y el recurso aws_s3_bucket lee esa
# configuracion despues de crear, asi que siempre falla. Todo lo que cuelga del
# bucket si lo maneja Terraform.
data "aws_s3_bucket" "snapshots" {
  depends_on = [terraform_data.lab_buckets]
  bucket     = local.snapshot_bucket_name
}

resource "aws_s3_bucket_versioning" "snapshots" {
  bucket = data.aws_s3_bucket.snapshots.bucket

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "snapshots" {
  bucket                  = data.aws_s3_bucket.snapshots.bucket
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "snapshots" {
  bucket = data.aws_s3_bucket.snapshots.bucket

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "snapshots" {
  bucket     = data.aws_s3_bucket.snapshots.bucket
  depends_on = [aws_s3_bucket_versioning.snapshots]

  # Un mundo corriendo reescribe su snapshot cada 30 s, asi que la edad de la
  # version actual es el tiempo que el mundo lleva sin usarse. A los 30 dias pasa
  # a Glacier Instant Retrieval: mismo GetObject, el mundo arranca al instante.
  # No se archiva en Deep Archive: el inicio bajo demanda no puede esperar ~12 h
  # de restore y el ahorro medido es menor a un centavo por mes
  # (.docs/decision-snapshots.md). Por debajo de 128 KB Glacier IR factura 128 KB
  # igual, asi que no conviene transicionar.
  rule {
    id     = "archive-idle-worlds"
    status = "Enabled"

    filter {
      and {
        prefix                   = "worlds/"
        object_size_greater_than = 131072
      }
    }

    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
  }

  # Con versionado y guardado cada 30 s, cada mundo activo genera ~2.880 versiones
  # por dia; las intermedias se borran a los 3 dias. Las ultimas 5 se conservan
  # siempre para poder volver atras tambien en un mundo que dejo de usarse.
  rule {
    id     = "expire-old-snapshot-versions"
    status = "Enabled"

    filter {
      prefix = "worlds/"
    }

    noncurrent_version_expiration {
      noncurrent_days           = 3
      newer_noncurrent_versions = 5
    }
  }
}

data "aws_s3_bucket" "client" {
  depends_on = [terraform_data.lab_buckets]
  bucket     = local.client_bucket_name
}

resource "aws_s3_bucket_website_configuration" "client" {
  bucket = data.aws_s3_bucket.client.bucket

  index_document {
    suffix = "index.html"
  }
}

resource "aws_s3_bucket_ownership_controls" "client" {
  bucket = data.aws_s3_bucket.client.bucket

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_public_access_block" "client" {
  bucket                  = data.aws_s3_bucket.client.bucket
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "client_read" {
  statement {
    sid       = "PublicReadClient"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${local.client_bucket_name}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "client_read" {
  bucket     = data.aws_s3_bucket.client.bucket
  policy     = data.aws_iam_policy_document.client_read.json
  depends_on = [aws_s3_bucket_public_access_block.client]
}

resource "aws_s3_object" "client_assets" {
  for_each = local.client_files

  bucket       = data.aws_s3_bucket.client.bucket
  key          = each.value
  source       = "${local.client_source_dir}/${each.value}"
  etag         = filemd5("${local.client_source_dir}/${each.value}")
  content_type = lookup(local.client_content_types, lower(element(split(".", each.value), length(split(".", each.value)) - 1)), "application/octet-stream")
}

resource "aws_s3_object" "runtime_config" {
  bucket       = data.aws_s3_bucket.client.bucket
  key          = "runtime-config.js"
  content_type = "application/javascript"
  content      = local.runtime_config_js
  etag         = md5(local.runtime_config_js)
}
