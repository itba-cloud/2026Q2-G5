# terraform test uses a mocked provider: it never creates AWS resources. Runs that
# push an image only plan, so the local-exec push never runs.
mock_provider "aws" {}

variables {
  name               = "ewo-npc"
  cluster_name       = "ewo-npc"
  container_name     = "npc"
  region             = "us-east-1"
  cpu                = 512
  memory             = 1024
  port               = 5001
  execution_role_arn = "arn:aws:iam::123456789012:role/LabRole"
  task_role_arn      = "arn:aws:iam::123456789012:role/LabRole"
  image              = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ewo-npc:test"
  environment        = { DB_PORT = "5432", AWS_REGION = "us-east-1" }
  health_check       = { command = ["CMD", "true"], interval = 15, timeout = 5, retries = 3, startPeriod = 60 }
  service = {
    subnet_ids         = ["subnet-0000000000000000a", "subnet-0000000000000000b"]
    security_group_ids = ["sg-00000000000000001"]
    assign_public_ip   = false
    desired_count      = 2
    autoscaling        = { min_count = 2, max_count = 4, cpu_target = 60, scale_out_cooldown = 60, scale_in_cooldown = 120 }
  }
}

run "service_with_autoscaling" {
  command = plan
  assert {
    condition = (
      aws_ecs_service.this[0].launch_type == "FARGATE" && aws_ecs_service.this[0].desired_count == 2 &&
      one(aws_ecs_service.this[0].network_configuration).assign_public_ip == false &&
      toset(one(aws_ecs_service.this[0].network_configuration).subnets) == toset(var.service.subnet_ids) &&
      one(aws_ecs_service.this[0].deployment_circuit_breaker).rollback && length(aws_ecs_service.this[0].load_balancer) == 0
    )
    error_message = "The service runs on Fargate in the given subnets, without public IPs, with rollback and no load balancer."
  }
  assert {
    condition     = aws_appautoscaling_target.this[0].min_capacity == 2 && aws_appautoscaling_target.this[0].max_capacity == 4 && one(aws_appautoscaling_policy.cpu[0].target_tracking_scaling_policy_configuration).target_value == 60
    error_message = "The service scales on CPU between min_count and max_count."
  }
  assert {
    condition     = aws_ecs_task_definition.this.network_mode == "awsvpc" && aws_ecs_task_definition.this.family == "ewo-npc" && aws_cloudwatch_log_group.this.name == "/ecs/ewo-npc" && aws_cloudwatch_log_group.this.retention_in_days == 14
    error_message = "awsvpc task definition named after the workload, with its log group."
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment == [{ name = "AWS_REGION", value = "us-east-1" }, { name = "DB_PORT", value = "5432" }] &&
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].healthCheck.interval == 15 &&
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].image == var.image
    )
    error_message = "The container receives the environment, the health check and the supplied image."
  }
  assert {
    condition     = length(aws_ecr_repository.this) == 0 && length(terraform_data.image_push) == 0
    error_message = "A supplied image is used as is."
  }
}

run "service_without_autoscaling" {
  command = plan
  variables {
    service = {
      subnet_ids         = ["subnet-0000000000000000a"]
      security_group_ids = ["sg-00000000000000001"]
      assign_public_ip   = false
      desired_count      = 2
    }
  }
  assert {
    condition     = length(aws_ecs_service.this) == 1 && length(aws_appautoscaling_target.this) == 0 && length(aws_appautoscaling_policy.cpu) == 0
    error_message = "Without autoscaling the service keeps a fixed number of tasks."
  }
}

run "service_behind_load_balancer" {
  command = plan
  variables {
    service = {
      subnet_ids         = ["subnet-0000000000000000a", "subnet-0000000000000000b"]
      security_group_ids = ["sg-00000000000000001"]
      assign_public_ip   = false
      desired_count      = 2
      load_balancer      = { target_group_arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/ewo-npc/0123456789abcdef", health_check_grace_period = 60 }
    }
  }
  assert {
    condition = (
      one(aws_ecs_service.this[0].load_balancer).target_group_arn == var.service.load_balancer.target_group_arn &&
      one(aws_ecs_service.this[0].load_balancer).container_name == "npc" && one(aws_ecs_service.this[0].load_balancer).container_port == 5001 &&
      aws_ecs_service.this[0].health_check_grace_period_seconds == 60
    )
    error_message = "The service registers the container port in the given target group, with the grace period."
  }
  assert {
    condition     = output.service_name == "ewo-npc" && output.target_group_arn == var.service.load_balancer.target_group_arn
    error_message = "Outputs expose the service name and its target group."
  }
}

run "task_definition_only" {
  command = plan
  variables {
    service      = null
    environment  = {}
    health_check = null
  }
  assert {
    condition     = length(aws_ecs_service.this) == 0 && output.service_network == null && output.autoscaling == null && output.service_name == null && output.target_group_arn == null
    error_message = "Without a service only the cluster and the task definition exist."
  }
  assert {
    condition     = !contains(keys(jsondecode(aws_ecs_task_definition.this.container_definitions)[0]), "environment") && !contains(keys(jsondecode(aws_ecs_task_definition.this.container_definitions)[0]), "healthCheck")
    error_message = "No environment or health check keys when none are given."
  }
}

run "push_to_immutable_ecr" {
  command = plan
  variables {
    image      = ""
    push_image = { source_image = "ewo-npc:abc123", script = "/dev/null", account_id = "123456789012" }
  }
  assert {
    condition     = aws_ecr_repository.this[0].name == "ewo-npc" && aws_ecr_repository.this[0].image_tag_mutability == "IMMUTABLE" && length(terraform_data.image_push) == 1
    error_message = "A source image is pushed to an immutable ECR repository named after the workload."
  }
}
