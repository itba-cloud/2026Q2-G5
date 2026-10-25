variable "name" {
  description = "Prefix for every Lobby function, workflow, schedule and alarm."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets the Lambdas attach to, one per Availability Zone."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security group of each function: public, internal, lifecycle and maintenance. The migration Lambda uses lifecycle's."
  type        = map(string)

  validation {
    condition     = alltrue([for key in ["public", "internal", "lifecycle", "maintenance"] : contains(keys(var.security_group_ids), key)])
    error_message = "Provide security groups for public, internal, lifecycle and maintenance."
  }
}

variable "lambda_zips" {
  description = "Deployment package of each function: public, internal, lifecycle, maintenance and migrate."
  type        = map(string)
}

variable "workflows_dir" {
  description = "Directory with the start-world and stop-world state machine definitions."
  type        = string
}

variable "migrations_dir" {
  description = "Directory with the SQL migrations; a change reruns the migration Lambda."
  type        = string
}

variable "lambda_role_arn" {
  description = "Existing role trusted by Lambda. The Learner Lab does not allow creating roles."
  type        = string
}

variable "workflow_role_arn" {
  description = "Existing role trusted by states.amazonaws.com."
  type        = string
}

variable "scheduler_role_arn" {
  description = "Existing role trusted by scheduler.amazonaws.com."
  type        = string
}

variable "environment" {
  description = "Application settings shared by every function."
  type        = map(string)
}

variable "database_resource_id" {
  description = "RDS resource id; a new database reruns the migration Lambda."
  type        = string
}

variable "lambda_concurrency" {
  description = "Reserved concurrency of the public, internal and lifecycle functions."
  type        = number
}

variable "maintenance_enabled" {
  type = bool
}

variable "maintenance_interval_minutes" {
  type = number
}
