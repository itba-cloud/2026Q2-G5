output "stream_name" {
  value = local.stream_name
}

output "stream_arn" {
  value = local.stream_arn
}

output "table_name" {
  value = aws_dynamodb_table.telemetry.name
}

output "application_name" {
  value = aws_kinesisanalyticsv2_application.telemetry.name
}

output "stream_created_with_script" {
  description = "Whether the stream comes from lab-stream.py (true) or from aws_kinesis_stream (false)."
  value       = length(terraform_data.lab_stream) == 1 && length(aws_kinesis_stream.telemetry) == 0
}
