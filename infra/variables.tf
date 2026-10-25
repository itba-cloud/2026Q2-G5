variable "aws_region" {
  description = "AWS region used by the Learner Lab."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Lowercase prefix used in resource names."
  type        = string
  default     = "elastic-worlds"
}

variable "db_multi_az" {
  description = "Keep a synchronous RDS standby in the second AZ. Doubles the database cost; false only for disposable test environments."
  type        = bool
  default     = true
}

variable "db_username" {
  description = "RDS master username."
  type        = string
  default     = "dbadmin"
}

variable "world_image" {
  description = "World Service image built from source or pulled for the bootstrap. Fargate pulls world_task_image instead."
  type        = string
  default     = "agromero/elastic-worlds-world-service:latest"
}

variable "npc_image" {
  description = "NPC Service image built from source or pulled for the bootstrap. Fargate pulls npc_task_image instead."
  type        = string
  default     = "agromero/elastic-worlds-npc-service:latest"
}

variable "metrics_image" {
  description = "Metrics Service image built from source or pulled for the bootstrap. Fargate pulls metrics_task_image instead."
  type        = string
  default     = "agromero/elastic-worlds-metrics-service:latest"
}

variable "metrics_user" {
  description = "Username for Basic Auth in metrics service"
  type        = string
  default     = "admin"
}

variable "metrics_password_version" {
  description = "Increment to generate a new Metrics password; ECS replaces the Metrics tasks, which read it at startup."
  type        = number
  default     = 1
}

variable "flink_job_jar_path" {
  description = "Uber jar of the telemetry job, produced by `mvn package` in flink-metrics-job/."
  type        = string
  default     = "../flink-metrics-job/target/flink-metrics-job.jar"
}

variable "lab_role_name" {
  description = "Existing Learner Lab IAM role used as the Managed Flink service execution role. Terraform never creates IAM roles."
  type        = string
  default     = "LabRole"
}

variable "vpc_cidr" {
  description = "VPC IPv4 CIDR; subnet CIDRs are derived with eight additional prefix bits."
  type        = string
  default     = "10.0.0.0/16"
}
