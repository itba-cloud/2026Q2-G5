# terraform test uses a mocked provider: it never creates AWS resources. Runs only
# plan, so the lab-stream.py provisioner never runs.
mock_provider "aws" {}

variables {
  name                      = "ewo-test"
  region                    = "us-east-1"
  account_id                = "123456789012"
  create_stream_with_script = false
  stream_script             = "/dev/null"
  artifacts_bucket          = { id = "ewo-test-artifacts", arn = "arn:aws:s3:::ewo-test-artifacts" }
  flink_jar_path            = "tests/telemetry.tftest.hcl"
  service_role_arn          = "arn:aws:iam::123456789012:role/LabRole"
}

run "stream_from_terraform" {
  command = plan
  assert {
    condition     = length(aws_kinesis_stream.telemetry) == 1 && aws_kinesis_stream.telemetry[0].name == "ewo-test-telemetry" && aws_kinesis_stream.telemetry[0].shard_count == 1 && aws_kinesis_stream.telemetry[0].retention_period == 24 && length(terraform_data.lab_stream) == 0
    error_message = "Outside the Lab Terraform creates the one-shard, 24 h stream."
  }
  assert {
    condition     = aws_dynamodb_table.telemetry.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.telemetry.hash_key == "pk" && aws_dynamodb_table.telemetry.range_key == "sk" && one(aws_dynamodb_table.telemetry.ttl).enabled
    error_message = "On-demand table keyed by pk/sk with TTL."
  }
  assert {
    condition     = aws_kinesisanalyticsv2_application.telemetry.runtime_environment == "FLINK-1_20" && aws_kinesisanalyticsv2_application.telemetry.service_execution_role == var.service_role_arn && aws_kinesisanalyticsv2_application.telemetry.start_application
    error_message = "Flink 1.20 application running with the supplied role and started by default."
  }
  assert {
    condition     = aws_s3_object.flink_job_jar.bucket == "ewo-test-artifacts" && aws_s3_object.flink_job_jar.key == "flink/flink-metrics-job.jar"
    error_message = "The job jar goes to the artifacts bucket."
  }
}

run "stream_from_script" {
  command = plan
  variables {
    create_stream_with_script = true
  }
  assert {
    condition     = length(aws_kinesis_stream.telemetry) == 0 && length(terraform_data.lab_stream) == 1 && length(data.aws_kinesis_stream.lab) == 1
    error_message = "In the Lab the script creates the stream and Terraform only reads it."
  }
}
