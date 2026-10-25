# Pipeline de telemetria: World Service y NPC empujan muestras a Kinesis, Managed
# Flink las agrega y escribe el ultimo estado por mundo y la serie de la flota en
# DynamoDB, y el Metrics Service solo lee esa tabla. Contrato en
# .docs/telemetry-pipeline.md.
resource "aws_kinesis_stream" "telemetry" {
  count            = var.create_stream_with_script ? 0 : 1
  name             = "${var.name}-telemetry"
  shard_count      = 1
  retention_period = 24

  stream_mode_details {
    stream_mode = "PROVISIONED"
  }

  tags = {
    Name = "${var.name}-telemetry"
  }
}

# Provider 5.x calls IncreaseStreamRetentionPeriod even for the 24h default.
# Learner Lab denies that action; create the default stream without that call.
resource "terraform_data" "lab_stream" {
  count = var.create_stream_with_script ? 1 : 0
  input = {
    project = var.name
    region  = var.region
    account = var.account_id
    script  = var.stream_script
  }
  provisioner "local-exec" {
    command = "python3 '${self.input.script}' create"
    environment = {
      PROJECT_NAME        = self.input.project
      AWS_REGION          = self.input.region
      EXPECTED_ACCOUNT_ID = self.input.account
    }
  }
  provisioner "local-exec" {
    when    = destroy
    command = "python3 '${self.input.script}' destroy"
    environment = {
      PROJECT_NAME        = self.input.project
      AWS_REGION          = self.input.region
      EXPECTED_ACCOUNT_ID = self.input.account
    }
  }
}

data "aws_kinesis_stream" "lab" {
  count      = var.create_stream_with_script ? 1 : 0
  name       = "${var.name}-telemetry"
  depends_on = [terraform_data.lab_stream]
}

locals {
  stream_name = var.create_stream_with_script ? data.aws_kinesis_stream.lab[0].name : aws_kinesis_stream.telemetry[0].name
  stream_arn  = var.create_stream_with_script ? data.aws_kinesis_stream.lab[0].arn : aws_kinesis_stream.telemetry[0].arn
}

resource "aws_dynamodb_table" "telemetry" {
  name         = "${var.name}-telemetry"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    Name = "${var.name}-telemetry"
  }
}

# El jar lo produce `mvn package` en flink-metrics-job/. Si no existe, filemd5
# corta el plan con un error claro en vez de desplegar una aplicacion vacia.
resource "aws_s3_object" "flink_job_jar" {
  bucket      = var.artifacts_bucket.id
  key         = "flink/flink-metrics-job.jar"
  source      = var.flink_jar_path
  source_hash = var.flink_source_hash != null ? var.flink_source_hash : filemd5(var.flink_jar_path)
}

resource "aws_cloudwatch_log_group" "flink" {
  name              = "/aws/kinesis-analytics/${var.name}-telemetry-job"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_stream" "flink" {
  name           = "flink-application"
  log_group_name = aws_cloudwatch_log_group.flink.name
}

resource "aws_kinesisanalyticsv2_application" "telemetry" {
  name                   = "${var.name}-telemetry-job"
  runtime_environment    = "FLINK-1_20"
  application_mode       = "STREAMING"
  service_execution_role = var.service_role_arn
  start_application      = var.start_application

  application_configuration {
    application_code_configuration {
      code_content {
        s3_content_location {
          bucket_arn     = var.artifacts_bucket.arn
          file_key       = aws_s3_object.flink_job_jar.key
          object_version = aws_s3_object.flink_job_jar.version_id
        }
      }

      code_content_type = "ZIPFILE"
    }

    environment_properties {
      property_group {
        property_group_id = "TelemetryJob"

        property_map = {
          "aws.region"             = var.region
          "stream.arn"             = local.stream_arn
          "table.name"             = aws_dynamodb_table.telemetry.name
          "fleet.window.seconds"   = "10"
          "rolling.window.seconds" = "60"
          "item.ttl.days"          = "7"
          "history.ttl.hours"      = "24"
        }
      }
    }

    flink_application_configuration {
      checkpoint_configuration {
        configuration_type = "DEFAULT"
      }

      monitoring_configuration {
        configuration_type = "CUSTOM"
        log_level          = "INFO"
        metrics_level      = "APPLICATION"
      }

      # Un KPU alcanza de sobra: a lo sumo 20 mundos emiten una muestra cada 5 s.
      parallelism_configuration {
        configuration_type   = "CUSTOM"
        parallelism          = 1
        parallelism_per_kpu  = 1
        auto_scaling_enabled = false
      }
    }
  }

  cloudwatch_logging_options {
    log_stream_arn = aws_cloudwatch_log_stream.flink.arn
  }

  tags = {
    Name = "${var.name}-telemetry-job"
  }
}
