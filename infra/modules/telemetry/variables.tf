variable "name" {
  description = "Prefix for the stream, table, Flink application and log group (<name>-telemetry...)."
  type        = string
}

variable "region" {
  type = string
}

variable "account_id" {
  description = "Account the stream script must run against; it refuses any other."
  type        = string
}

variable "create_stream_with_script" {
  description = "Create the Kinesis stream with scripts/lab-stream.py instead of aws_kinesis_stream. The Learner Lab denies an API call the provider makes on create."
  type        = bool
}

variable "stream_script" {
  description = "Path to scripts/lab-stream.py, relative to the Terraform working directory."
  type        = string
}

variable "flink_source_hash" {
  description = "Immutable build-input fingerprint; null uses the JAR byte hash for manual builds."
  type        = string
  default     = null
}

variable "artifacts_bucket" {
  description = "Versioned bucket for the Flink job jar. Versioning must be enabled before the upload."
  type = object({
    id  = string
    arn = string
  })
}

variable "flink_jar_path" {
  type = string
}

variable "service_role_arn" {
  description = "Existing role the Flink application runs with. The Learner Lab does not allow creating roles."
  type        = string
}

variable "start_application" {
  type    = bool
  default = true
}
