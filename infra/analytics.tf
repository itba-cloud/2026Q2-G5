# Pipeline de telemetria: World Service y NPC empujan muestras a Kinesis, Managed
# Flink las agrega y escribe el ultimo estado por mundo y la serie de la flota en
# DynamoDB, y el Metrics Service solo lee esa tabla. Contrato en
# .docs/telemetry-pipeline.md. El pipeline vive en modules/telemetry.

# Creado por el bootstrap opcional o bootstrap-buckets.sh por la restriccion del SCP
# tres buckets (ver storage.tf).
data "aws_s3_bucket" "artifacts" {
  depends_on = [terraform_data.lab_buckets]
  bucket     = local.artifacts_bucket_name
}

# Con versionado, cada jar nuevo tiene un version_id distinto y la aplicacion de
# Flink referencia esa version: asi un `mvn package` seguido de `terraform apply`
# actualiza el job en vez de dejarlo corriendo con el codigo viejo.
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = data.aws_s3_bucket.artifacts.bucket

  versioning_configuration {
    status = "Enabled"
  }
}

# El Learner Lab no permite crear roles IAM: la aplicacion de Flink corre con el
# LabRole preexistente, que ya puede leer Kinesis y S3 y escribir DynamoDB y
# CloudWatch Logs. Si kinesisanalytics.amazonaws.com no figura en su trust policy,
# el apply falla al crear la aplicacion (ver quickstart, seccion de verificacion).
data "aws_iam_role" "lab" {
  name = var.lab_role_name
}

module "telemetry" {
  source = "./modules/telemetry"

  name                      = var.project_name
  region                    = var.aws_region
  account_id                = data.aws_caller_identity.current.account_id
  create_stream_with_script = var.bootstrap_from_source
  stream_script             = "${path.module}/../scripts/lab-stream.py"
  # El bucket sale del recurso de versionado para que el jar se suba despues de
  # activarlo: cada jar nuevo tiene su version_id y Flink referencia esa version.
  artifacts_bucket = {
    id  = aws_s3_bucket_versioning.artifacts.bucket
    arn = "arn:${data.aws_partition.current.partition}:s3:::${local.artifacts_bucket_name}"
  }
  flink_jar_path    = local.flink_jar
  flink_source_hash = var.bootstrap_from_source ? data.external.lab_assets[0].result.source_digest : null
  service_role_arn  = data.aws_iam_role.lab.arn
  start_application = var.start_telemetry_application
}

locals {
  telemetry_stream_name = module.telemetry.stream_name
}
