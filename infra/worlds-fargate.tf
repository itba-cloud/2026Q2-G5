# Mundos en Fargate: una task ECS por mundo, lanzada por la Lambda de lifecycle.
# El launcher docker queda solo para desarrollo local; el despliegue no tiene
# World Hosts EC2.
variable "world_health_timeout_ms" {
  description = "Readiness deadline for a starting world: covers the task ENI and the image pull."
  type        = number
  default     = 120000
}

variable "world_task_cpu" {
  type    = number
  default = 256
}

variable "world_task_memory" {
  type    = number
  default = 512
}

variable "world_task_image" {
  description = "World image URI Fargate pulls. Empty with bootstrap_from_source pushes the source-built image to ECR."
  type        = string
  default     = ""
}

locals {
  world_task_port = 8001
  world_ecr_push  = var.bootstrap_from_source && var.world_task_image == ""

  world_launcher_env = {
    WORLD_LAUNCHER             = "fargate"
    HEALTH_TIMEOUT_MS          = tostring(var.world_health_timeout_ms)
    ECS_CLUSTER                = module.world_tasks.cluster_name
    WORLD_TASK_DEFINITION      = module.world_tasks.task_definition_arn
    WORLD_TASK_CONTAINER       = "world"
    WORLD_TASK_SUBNETS         = join(",", module.network.public_subnet_ids)
    WORLD_TASK_SECURITY_GROUPS = aws_security_group.world_task.id
    WORLD_TASK_PUBLIC_IP       = "true"
    WORLD_TASK_PORT            = tostring(local.world_task_port)
  }
}

resource "terraform_data" "world_checks" {
  input = var.world_task_image
  lifecycle {
    precondition {
      condition     = var.bootstrap_from_source || var.world_task_image != ""
      error_message = "Fargate needs a pullable world image: set world_task_image or bootstrap from source to push it to ECR."
    }
  }
}

# Solo la task definition: cada mundo lo lanza la Lambda de lifecycle con RunTask.
# Fargate no cachea imagenes entre tasks, asi que cada mundo la baja de ECR.
# LabRole hace de execution role (pull de ECR, logs) y de task role (S3 y Kinesis
# del mundo). Terraform no crea roles en el Learner Lab.
module "world_tasks" {
  source = "./modules/container-workload"

  name               = "${var.project_name}-world"
  cluster_name       = "${var.project_name}-worlds"
  container_name     = "world"
  region             = var.aws_region
  cpu                = var.world_task_cpu
  memory             = var.world_task_memory
  port               = local.world_task_port
  execution_role_arn = data.aws_iam_role.lab.arn
  task_role_arn      = data.aws_iam_role.lab.arn

  image = var.world_task_image
  push_image = local.world_ecr_push ? {
    source_image = local.world_image
    script       = "${path.module}/../scripts/push-ecr-image.py"
    account_id   = data.aws_caller_identity.current.account_id
  } : null

  depends_on = [terraform_data.world_checks]
}

# Cada task tiene su ENI en una subred publica: los jugadores abren el WebSocket
# directo contra su IP publica, siempre en el mismo puerto.
resource "aws_security_group" "world_task" {
  name        = "${var.project_name}-world-task-sg"
  description = "World Fargate tasks"
  vpc_id      = module.network.vpc_id

  ingress {
    description = "Player WebSockets"
    from_port   = local.world_task_port
    to_port     = local.world_task_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description     = "NPC connections and Lobby health checks"
    from_port       = local.world_task_port
    to_port         = local.world_task_port
    protocol        = "tcp"
    security_groups = concat([aws_security_group.npc.id], values(local.lobby_effect_sgs))
  }
}

resource "aws_security_group_rule" "world_task_to_internal_alb" {
  description              = "World status reports and shutdowns through the Internal ALB"
  type                     = "egress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  security_group_id        = aws_security_group.world_task.id
  source_security_group_id = aws_security_group.internal_alb.id
}

resource "aws_security_group_rule" "world_task_to_redis" {
  description              = "World chat and events"
  type                     = "egress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.world_task.id
  source_security_group_id = aws_security_group.redis.id
}

# ECR, CloudWatch Logs, S3 y Kinesis por HTTPS: sin NAT, la task sale por su IP
# publica; S3 y Kinesis igual resuelven a sus endpoints dentro de la VPC.
resource "aws_security_group_rule" "world_task_https" {
  description       = "Image pull, logs, snapshots and telemetry"
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.world_task.id
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "world_task_dns" {
  description       = "VPC DNS resolution"
  type              = "egress"
  from_port         = 53
  to_port           = 53
  protocol          = "udp"
  security_group_id = aws_security_group.world_task.id
  cidr_blocks       = [module.network.vpc_cidr_block]
}

resource "aws_security_group_rule" "lobby_effect_world_task" {
  for_each                 = local.lobby_effect_sgs
  description              = "Health checks of world tasks"
  type                     = "egress"
  from_port                = local.world_task_port
  to_port                  = local.world_task_port
  protocol                 = "tcp"
  security_group_id        = each.value
  source_security_group_id = aws_security_group.world_task.id
}

resource "aws_security_group_rule" "lobby_effect_world_api" {
  for_each                 = local.lobby_effect_sgs
  description              = "ECS and EC2 API through VPC endpoints"
  type                     = "egress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = each.value
  source_security_group_id = module.network.endpoint_security_group_ids["world_api"]
}

output "world_tasks" {
  description = "ECS cluster and task definition the lifecycle Lambda launches one world task from. List running worlds with: aws ecs list-tasks --cluster <cluster>"
  value = {
    cluster         = module.world_tasks.cluster_name
    task_definition = module.world_tasks.task_definition_arn
    image           = module.world_tasks.image
  }
}
