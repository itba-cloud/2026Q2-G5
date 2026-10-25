# NPC Service como ECS Service en Fargate: N replicas en las dos subredes privadas.
# Las replicas no reciben pedidos del Lobby: cada una toma mundos con un lease en
# RDS (tabla npc_leases) y reconcilia sus bots contra la tabla worlds. Si una task
# muere, sus leases vencen y otra replica se queda con esos mundos.
variable "npc_task_image" {
  description = "NPC image URI Fargate pulls. Empty with bootstrap_from_source pushes the source-built image to ECR."
  type        = string
  default     = ""
}

variable "npc_task_cpu" {
  type    = number
  default = 512
}

variable "npc_task_memory" {
  type    = number
  default = 1024
}

variable "npc_min_count" {
  description = "Minimum NPC replicas. Two keep one task per private subnet (AZ)."
  type        = number
  default     = 2
}

variable "npc_max_count" {
  type    = number
  default = 4
}

variable "npc_autoscaling_enabled" {
  description = "Scale the NPC service on CPU. Needs the Application Auto Scaling service-linked role for ECS."
  type        = bool
  default     = true
}

variable "npc_max_worlds_per_task" {
  description = "Worlds a replica claims at most. Keep it above what CPU allows so autoscaling, not this cap, is the limit."
  type        = number
  default     = 10
}

locals {
  npc_task_port = 5001
  npc_ecr_push  = var.bootstrap_from_source && var.npc_task_image == ""
}

resource "terraform_data" "npc_checks" {
  input = var.npc_task_image
  lifecycle {
    precondition {
      condition     = var.bootstrap_from_source || var.npc_task_image != ""
      error_message = "The NPC tasks run without internet access: set npc_task_image to an ECR image or bootstrap from source to push it."
    }
    precondition {
      condition     = var.npc_min_count >= 1 && var.npc_max_count >= var.npc_min_count
      error_message = "npc_max_count must be at least npc_min_count, and npc_min_count at least 1."
    }
  }
}

# LabRole hace de execution role (pull de ECR, logs) y de task role (password de
# RDS en S3 y PutRecords en Kinesis). Terraform no crea roles en el Learner Lab.
module "npc" {
  source = "./modules/container-workload"

  name               = "${var.project_name}-npc"
  cluster_name       = "${var.project_name}-npc"
  container_name     = "npc"
  region             = var.aws_region
  cpu                = var.npc_task_cpu
  memory             = var.npc_task_memory
  port               = local.npc_task_port
  execution_role_arn = data.aws_iam_role.lab.arn
  task_role_arn      = data.aws_iam_role.lab.arn

  image = var.npc_task_image
  push_image = local.npc_ecr_push ? {
    source_image = local.npc_image
    script       = "${path.module}/../scripts/push-ecr-image.py"
    account_id   = data.aws_caller_identity.current.account_id
  } : null

  environment = {
    NPC_HTTP_PORT              = tostring(local.npc_task_port)
    NPC_HTTP_HOST              = "0.0.0.0"
    NPC_ASSIGNMENT_MODE        = "leases"
    DB_HOST                    = module.data.address
    DB_PORT                    = "5432"
    DB_NAME                    = "cloudgame"
    DB_USER                    = var.db_username
    DB_SECRET_ARN              = module.data.master_user_secret_arn
    DB_CA_FILE                 = "/app/rds-ca.pem"
    MAX_WORLDS_PER_TASK        = tostring(var.npc_max_worlds_per_task)
    LEASE_TTL_SECONDS          = "15"
    RECONCILE_INTERVAL_SECONDS = "3"
    TELEMETRY_MODE             = "kinesis"
    TELEMETRY_STREAM_NAME      = local.telemetry_stream_name
    AWS_REGION                 = var.aws_region
  }

  # /health answers 503 when the reconcile loop stalls; ECS then replaces the task.
  health_check = {
    command     = ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${local.npc_task_port}/health', timeout=3)"]
    interval    = 15
    timeout     = 5
    retries     = 3
    startPeriod = 60
  }

  # Replicas en las dos subredes privadas, sin IP publica.
  service = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [aws_security_group.npc.id]
    assign_public_ip   = false
    desired_count      = var.npc_min_count
    autoscaling = var.npc_autoscaling_enabled ? {
      min_count          = var.npc_min_count
      max_count          = var.npc_max_count
      cpu_target         = 60
      scale_out_cooldown = 60
      scale_in_cooldown  = 120
    } : null
  }

  # Sin los endpoints la task no puede bajar la imagen ni escribir logs; sin la
  # regla de RDS no puede tomar leases y nunca pasa el health check.
  depends_on = [terraform_data.npc_checks, module.network, aws_security_group_rule.endpoint_ingress, aws_security_group.rds]
}
