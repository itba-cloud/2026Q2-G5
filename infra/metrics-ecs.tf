# Metrics Service como ECS Service en Fargate: N replicas en las dos subredes
# privadas, detras del ALB publico. No tiene estado (lee el ultimo snapshot de
# cada mundo y la serie de la flota de DynamoDB, escritas por el job de Flink, y
# el registro de mundos y hosts del Lobby por el Internal ALB), asi que cualquier
# replica responde lo mismo y el ALB reparte /api/metrics* entre todas.
variable "metrics_task_image" {
  description = "Metrics image URI Fargate pulls. Empty with bootstrap_from_source pushes the source-built image to ECR."
  type        = string
  default     = ""
}

variable "metrics_task_cpu" {
  type    = number
  default = 256
}

variable "metrics_task_memory" {
  type    = number
  default = 512
}

variable "metrics_min_count" {
  description = "Minimum Metrics replicas. Two keep one task per private subnet (AZ)."
  type        = number
  default     = 2
}

variable "metrics_max_count" {
  type    = number
  default = 4
}

variable "metrics_autoscaling_enabled" {
  description = "Scale the Metrics service on CPU. Needs the Application Auto Scaling service-linked role for ECS."
  type        = bool
  default     = true
}

locals {
  metrics_task_port = 3100
  metrics_ecr_push  = var.bootstrap_from_source && var.metrics_task_image == ""
}

resource "terraform_data" "metrics_checks" {
  input = var.metrics_task_image
  lifecycle {
    precondition {
      condition     = var.bootstrap_from_source || var.metrics_task_image != ""
      error_message = "The Metrics tasks run without internet access: set metrics_task_image to an ECR image or bootstrap from source to push it."
    }
    precondition {
      condition     = var.metrics_min_count >= 1 && var.metrics_max_count >= var.metrics_min_count
      error_message = "metrics_max_count must be at least metrics_min_count, and metrics_min_count at least 1."
    }
  }
}

# LabRole hace de execution role (pull de ECR, logs) y de task role (password de
# Basic Auth en S3 y lectura de DynamoDB). Terraform no crea roles en el Learner Lab.
module "metrics" {
  source = "./modules/container-workload"

  name               = "${var.project_name}-metrics"
  cluster_name       = "${var.project_name}-metrics"
  container_name     = "metrics"
  region             = var.aws_region
  cpu                = var.metrics_task_cpu
  memory             = var.metrics_task_memory
  port               = local.metrics_task_port
  execution_role_arn = data.aws_iam_role.lab.arn
  task_role_arn      = data.aws_iam_role.lab.arn

  image = var.metrics_task_image
  push_image = local.metrics_ecr_push ? {
    source_image = local.metrics_image
    script       = "${path.module}/../scripts/push-ecr-image.py"
    account_id   = data.aws_caller_identity.current.account_id
  } : null

  # Sin user-data, el contenedor lee su contraseña de Secrets Manager al arrancar
  # (por el endpoint de interfaz), como las Lambdas del Lobby y el NPC la de RDS.
  # La version entra al entorno para que rotarla genere una task definition nueva
  # y ECS reemplace las tasks con la contraseña nueva.
  environment = {
    METRICS_PORT           = tostring(local.metrics_task_port)
    METRICS_HOST           = "0.0.0.0"
    METRICS_USER           = var.metrics_user
    METRICS_PASS_SECRET_ID = aws_secretsmanager_secret.metrics_password.arn
    METRICS_PASS_VERSION   = tostring(var.metrics_password_version)
    LOBBY_URL              = "http://${aws_lb.internal.dns_name}"
    TELEMETRY_MODE         = "dynamodb"
    TELEMETRY_TABLE_NAME   = module.telemetry.table_name
    AWS_REGION             = var.aws_region
    PRICING_INSTANCE_TYPE  = "t3.medium"
    PRICING_EBS_GB         = "30"
  }

  # Replicas en las dos subredes privadas, sin IP publica, registradas en el
  # target group de /api/metrics*. El health check del ALB (/health) decide que
  # task se reemplaza.
  service = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [aws_security_group.metrics.id]
    assign_public_ip   = false
    desired_count      = var.metrics_min_count
    load_balancer = {
      target_group_arn          = aws_lb_target_group.metrics.arn
      health_check_grace_period = 60
    }
    autoscaling = var.metrics_autoscaling_enabled ? {
      min_count          = var.metrics_min_count
      max_count          = var.metrics_max_count
      cpu_target         = 60
      scale_out_cooldown = 60
      scale_in_cooldown  = 120
    } : null
  }

  # Sin los endpoints la task no puede bajar la imagen ni escribir logs ni leer su
  # contraseña; ECS rechaza el service si el target group aun no cuelga de un
  # listener; sin la version del secreto la task no arranca.
  depends_on = [terraform_data.metrics_checks, module.network, aws_security_group_rule.endpoint_ingress, aws_lb_listener_rule.metrics, aws_secretsmanager_secret_version.metrics_password]
}
