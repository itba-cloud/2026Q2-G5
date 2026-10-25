locals {
  # El tag de la imagen fuente es el digest del codigo, asi que el repo es inmutable.
  image = var.push_image == null ? var.image : "${aws_ecr_repository.this[0].repository_url}:${split(":", var.push_image.source_image)[1]}"
}

resource "aws_ecr_repository" "this" {
  count                = var.push_image == null ? 0 : 1
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
}

resource "terraform_data" "image_push" {
  count            = var.push_image == null ? 0 : 1
  triggers_replace = [local.image]
  input = {
    script  = var.push_image.script
    source  = var.push_image.source_image
    target  = local.image
    region  = var.region
    account = var.push_image.account_id
  }
  provisioner "local-exec" {
    command = "python3 '${self.input.script}'"
    environment = {
      SOURCE_IMAGE        = self.input.source
      TARGET_IMAGE        = self.input.target
      AWS_REGION          = self.input.region
      EXPECTED_ACCOUNT_ID = self.input.account
    }
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.cluster_name
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([merge(
    {
      name         = var.container_name
      image        = local.image
      essential    = true
      stopTimeout  = 30
      portMappings = [{ containerPort = var.port, protocol = "tcp" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = var.region
          awslogs-stream-prefix = var.container_name
        }
      }
    },
    length(var.environment) == 0 ? {} : {
      environment = [for name, value in var.environment : { name = name, value = value }]
    },
    var.health_check == null ? {} : { healthCheck = var.health_check },
  )])
  depends_on = [terraform_data.image_push]
}

resource "aws_ecs_service" "this" {
  count                              = var.service == null ? 0 : 1
  name                               = var.name
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.this.arn
  launch_type                        = "FARGATE"
  desired_count                      = var.service.desired_count
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  # Detras de un balanceador, ECS reemplaza las tasks que el target group marca
  # unhealthy; el periodo de gracia cubre el arranque del contenedor.
  health_check_grace_period_seconds = try(var.service.load_balancer.health_check_grace_period, null)

  network_configuration {
    subnets          = var.service.subnet_ids
    security_groups  = var.service.security_group_ids
    assign_public_ip = var.service.assign_public_ip
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "load_balancer" {
    for_each = try(var.service.load_balancer, null) == null ? [] : [var.service.load_balancer]
    content {
      target_group_arn = load_balancer.value.target_group_arn
      container_name   = var.container_name
      container_port   = var.port
    }
  }

  # El autoscaling mueve desired_count; Terraform solo fija el valor inicial.
  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "this" {
  count              = try(var.service.autoscaling, null) == null ? 0 : 1
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.service.autoscaling.min_count
  max_capacity       = var.service.autoscaling.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = length(aws_appautoscaling_target.this)
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.service.autoscaling.cpu_target
    scale_out_cooldown = var.service.autoscaling.scale_out_cooldown
    scale_in_cooldown  = var.service.autoscaling.scale_in_cooldown
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
