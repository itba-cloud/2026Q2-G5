variable "lobby_maintenance_enabled" {
  description = "Enable the single regional schedule that runs Lobby maintenance."
  type        = bool
  default     = true
}

variable "lobby_maintenance_interval_minutes" {
  type    = number
  default = 1
  validation {
    condition     = contains([1, 2], var.lobby_maintenance_interval_minutes)
    error_message = "Maintenance runs every 1 or 2 minutes."
  }
}

variable "lobby_scheduler_role_arn" {
  description = "Existing scheduler.amazonaws.com role allowed to invoke only the maintenance live alias."
  type        = string
  default     = ""
}

variable "lobby_lambda_role_arn" {
  description = "Existing role trusted by Lambda, with VPC ENI, logs and secret-object read permissions."
  type        = string
  default     = ""
}

variable "lobby_workflow_role_arn" {
  description = "Existing role trusted by states.amazonaws.com, with permission to invoke lifecycle versions."
  type        = string
  default     = ""
}

variable "lobby_lambda_package_dir" {
  description = "Directory containing public.zip, internal.zip, lifecycle.zip, maintenance.zip and migrate.zip, built by npm --prefix lobby-service run package:lambda."
  type        = string
  default     = "../lobby-service/dist/lambdas"
}

variable "lobby_lambda_concurrency" {
  description = "Per function limit. With pools of one, 3x10 + maintenance concurrency 1 leaves a bounded connection budget. Measure against actual RDS limits."
  type        = number
  default     = 10
}

resource "terraform_data" "lobby_serverless_checks" {
  input = var.lobby_lambda_concurrency
  lifecycle {
    precondition {
      condition     = local.lambda_role_arn != "" && local.workflow_role_arn != "" && local.scheduler_role_arn != ""
      error_message = "Supply preflight-verified Lambda, Step Functions and Scheduler roles. Terraform does not create or modify Lab roles."
    }
    precondition {
      condition     = var.lobby_lambda_concurrency >= 1 && var.lobby_lambda_concurrency <= 20
      error_message = "Keep concurrency between 1 and 20 until the database connection budget is measured."
    }
  }
}

locals {
  lobby_lambda_env = merge({
    STORAGE_MODE              = "rds"
    LIFECYCLE_MODE            = "async"
    MIGRATE_ON_START          = "false"
    RECONCILE_ENABLED         = "false"
    RECONCILE_ON_READ         = "false"
    DB_POOL_MAX               = "1"
    DB_HOST                   = module.data.address
    DB_PORT                   = "5432"
    DB_NAME                   = "cloudgame"
    DB_USER                   = var.db_username
    DB_SECRET_ARN             = module.data.master_user_secret_arn
    DB_CA_FILE                = "/var/task/certs/rds-ca.pem"
    CORS_ORIGINS              = "*"
    REDIS_URL                 = module.data.redis_url
    GLOBAL_CHANNEL            = "world-events"
    WORLD_STORAGE_MODE        = "s3"
    S3_BUCKET_NAME            = data.aws_s3_bucket.snapshots.bucket
    S3_PREFIX                 = "worlds"
    WORLD_TELEMETRY_MODE      = "kinesis"
    TELEMETRY_STREAM_NAME     = local.telemetry_stream_name
    LOBBY_LOAD_BALANCER_URL   = "http://${aws_lb.internal.dns_name}"
    OPERATION_TIMEOUT_SECONDS = "600"
  }, local.world_launcher_env)
}

module "lobby" {
  source = "./modules/lobby"

  name       = var.project_name
  subnet_ids = module.network.private_subnet_ids
  security_group_ids = {
    public      = aws_security_group.lobby_http["public"].id
    internal    = aws_security_group.lobby_http["internal"].id
    lifecycle   = aws_security_group.lobby_lifecycle.id
    maintenance = aws_security_group.lobby_maintenance.id
  }
  lambda_zips                  = local.lambda_zips
  workflows_dir                = "${path.module}/workflows"
  migrations_dir               = "${path.module}/../lobby-service/src/store/migrations"
  lambda_role_arn              = local.lambda_role_arn
  workflow_role_arn            = local.workflow_role_arn
  scheduler_role_arn           = local.scheduler_role_arn
  environment                  = local.lobby_lambda_env
  database_resource_id         = module.data.resource_id
  lambda_concurrency           = var.lobby_lambda_concurrency
  maintenance_enabled          = var.lobby_maintenance_enabled
  maintenance_interval_minutes = var.lobby_maintenance_interval_minutes

  # La migracion necesita llegar a RDS y a su secreto antes de correr.
  depends_on = [terraform_data.lobby_serverless_checks, aws_security_group_rule.lobby_runtime_db, aws_security_group_rule.lobby_runtime_secrets]
}

output "lobby_serverless_workflows" {
  value = module.lobby.workflows
}

output "lobby_lambda_functions" {
  value = module.lobby.function_names
}

output "lobby_maintenance_alias_arn" {
  value = module.lobby.maintenance_alias_arn
}
