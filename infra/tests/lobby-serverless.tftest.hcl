# terraform test uses a mocked provider: it never creates AWS resources.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/ExistingLabRole" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
}

mock_provider "external" {
  mock_data "external" {
    defaults = { result = {
      world_image            = "test-world:source"
      npc_image              = "test-npc:source"
      metrics_image          = "test-metrics:source"
      source_digest          = "source-test"
      lambda_public_zip      = "../lobby-service/dist/lambdas/public.zip"
      lambda_internal_zip    = "../lobby-service/dist/lambdas/internal.zip"
      lambda_lifecycle_zip   = "../lobby-service/dist/lambdas/lifecycle.zip"
      lambda_maintenance_zip = "../lobby-service/dist/lambdas/maintenance.zip"
      lambda_migrate_zip     = "../lobby-service/dist/lambdas/migrate.zip"
      flink_jar              = "../lobby-service/package.json"
    } }
  }
}

# La red tiene sus propios tests (modules/network/tests). Aca se reemplaza por
# salidas fijas para verificar como la consumen los demas recursos.
override_module {
  target = module.network
  outputs = {
    vpc_id                      = "vpc-00000000000000000"
    vpc_cidr_block              = "10.0.0.0/16"
    public_subnet_ids           = ["subnet-0000000000000000c", "subnet-0000000000000000d"]
    private_subnet_ids          = ["subnet-0000000000000000a", "subnet-0000000000000000b"]
    database_subnet_ids         = ["subnet-0000000000000000e", "subnet-0000000000000000f"]
    elasticache_subnet_ids      = ["subnet-00000000000000010", "subnet-00000000000000011"]
    public_route_table_ids      = ["rtb-00000000000000001"]
    private_route_table_ids     = ["rtb-00000000000000002"]
    database_route_table_ids    = ["rtb-00000000000000003"]
    elasticache_route_table_ids = ["rtb-00000000000000004"]
    s3_prefix_list_id           = "pl-00000000"
    endpoint_security_group_ids = {
      telemetry  = "sg-00000000000000001"
      workflows  = "sg-00000000000000002"
      containers = "sg-00000000000000003"
      secrets    = "sg-00000000000000005"
      world_api  = "sg-00000000000000004"
    }
  }
}

variables {
  flink_job_jar_path       = "../lobby-service/package.json"
  lobby_lambda_role_arn    = "arn:aws:iam::123456789012:role/LambdaRole"
  lobby_workflow_role_arn  = "arn:aws:iam::123456789012:role/WorkflowRole"
  lobby_scheduler_role_arn = "arn:aws:iam::123456789012:role/SchedulerRole"
  npc_task_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/elastic-worlds-npc:test"
  metrics_task_image       = "123456789012.dkr.ecr.us-east-1.amazonaws.com/elastic-worlds-metrics:test"
  world_task_image         = "123456789012.dkr.ecr.us-east-1.amazonaws.com/elastic-worlds-world:test"
}

run "lobby_on_lambda" {
  command = plan
  variables {
    bootstrap_from_source = false
  }
  assert {
    condition     = toset(keys(module.lobby.function_names)) == toset(["public", "internal", "lifecycle", "maintenance"]) && toset(keys(module.lobby.workflows)) == toset(["start", "stop"]) && local.interface_endpoints["workflows"] == ["states"]
    error_message = "Provision the public and internal Lambdas, two workflows and only the states endpoint."
  }
  assert {
    condition     = length(aws_security_group_rule.lobby_maintenance_endpoints) == 3 && alltrue([for subnets in values(module.lobby.function_subnet_ids) : toset(subnets) == toset(["subnet-0000000000000000a", "subnet-0000000000000000b"])])
    error_message = "Every function attaches to both private subnets; public/internal dispatch and maintenance reach Step Functions."
  }
  assert {
    condition     = module.lobby.maintenance_schedule == { state = "ENABLED", expression = "rate(1 minute)" }
    error_message = "One enabled schedule invokes maintenance every minute."
  }
}

run "passwords_from_secrets_manager" {
  command = plan
  variables {
    bootstrap_from_source = false
  }
  assert {
    condition = alltrue([
      for env in values(module.lobby.function_environments) :
      contains(keys(env), "DB_SECRET_ARN") && !contains(keys(env), "DB_SECRET_S3_BUCKET") && !contains(keys(env), "DB_SECRET_S3_KEY")
    ])
    error_message = "Every Lobby function reads the RDS password from the secret RDS manages, not from S3."
  }
  assert {
    condition     = local.interface_endpoints["secrets"] == ["secretsmanager"] && length(aws_security_group_rule.lobby_runtime_secrets) == 4
    error_message = "Secrets Manager is reachable through its endpoint; the four Lobby security groups get HTTPS egress to it."
  }
  assert {
    condition = alltrue([
      for consumer in ["public", "internal", "lifecycle", "maintenance", "npc", "metrics"] :
      contains(keys(aws_security_group_rule.endpoint_ingress), "secrets-${consumer}")
    ])
    error_message = "Lobby functions, NPC replicas and Metrics instances may reach the Secrets Manager endpoint."
  }
  assert {
    condition     = aws_secretsmanager_secret.metrics_password.recovery_window_in_days == 0 && aws_secretsmanager_secret_version.metrics_password.secret_string_wo_version == 1
    error_message = "The Metrics password is written once per version, and its name is free again right after a destroy."
  }
}

run "redis_on_elasticache" {
  command = plan
  variables {
    bootstrap_from_source = false
  }
  override_module {
    target  = module.data.module.redis
    outputs = { replication_group_primary_endpoint_address = "master.ewo-redis.abc123.use1.cache.amazonaws.com" }
  }
  assert {
    condition     = module.lobby.function_environments["internal"]["REDIS_URL"] == "rediss://master.ewo-redis.abc123.use1.cache.amazonaws.com:6379"
    error_message = "The internal Lambda reaches the ElastiCache primary over TLS."
  }
  assert {
    condition     = anytrue([for rule in aws_security_group.redis.ingress : rule.self && rule.from_port == 6379])
    error_message = "The cache nodes reach each other on 6379 for replication."
  }
}

run "maintenance_disabled" {
  command = plan
  variables {
    bootstrap_from_source     = false
    lobby_maintenance_enabled = false
  }
  assert {
    condition     = module.lobby.maintenance_schedule.state == "DISABLED"
    error_message = "Disabling maintenance keeps the schedule paused."
  }
}

run "two_minute_schedule" {
  command = plan
  variables {
    bootstrap_from_source              = false
    lobby_maintenance_interval_minutes = 2
  }
  assert {
    condition     = module.lobby.maintenance_schedule.expression == "rate(2 minutes)"
    error_message = "The interval supports the requested two-minute alternative."
  }
}

run "fresh_account_serverless_defaults" {
  command = plan
  variables {
    lobby_lambda_role_arn    = ""
    lobby_workflow_role_arn  = ""
    lobby_scheduler_role_arn = ""
  }
  assert {
    condition     = length(terraform_data.lab_buckets) == 1 && module.telemetry.stream_created_with_script
    error_message = "Fresh account prepares buckets and the telemetry stream from source."
  }
  assert {
    condition     = length(module.lobby.function_names) == 4 && length(module.lobby.workflows) == 2 && module.lobby.maintenance_schedule == { state = "ENABLED", expression = "rate(1 minute)" }
    error_message = "Defaults must route the Lobby through Lambda with workflows and scheduled maintenance every minute."
  }
  assert {
    condition     = var.start_telemetry_application && !var.cleanup_bootstrap_buckets
    error_message = "Normal deployments start telemetry and retain bucket data on destroy; disposable test settings are opt-in."
  }
  assert {
    condition     = module.data.multi_az
    error_message = "RDS keeps a standby in the second AZ by default."
  }
  assert {
    condition     = length(module.lobby.function_packages) == 5 && length(toset(values(module.lobby.function_packages))) == 5
    error_message = "Each Lambda must receive its own deployment ZIP."
  }
}

run "worlds_on_fargate" {
  command = plan
  variables {
    bootstrap_from_source = false
  }
  assert {
    condition     = module.world_tasks.cluster_name == "elastic-worlds-worlds" && module.world_tasks.image == var.world_task_image && !module.world_tasks.pushes_image && module.world_tasks.service_network == null
    error_message = "Worlds run on a cluster with an awsvpc task definition using the supplied image, without an ECS service."
  }
  assert {
    condition     = local.interface_endpoints["world_api"] == ["ecs", "ec2"] && length(aws_security_group_rule.lobby_effect_world_api) == 2 && contains(keys(aws_security_group_rule.endpoint_ingress), "world_api-lifecycle") && contains(keys(aws_security_group_rule.endpoint_ingress), "world_api-maintenance") && length(aws_security_group_rule.lobby_effect_world_task) == 2
    error_message = "Lifecycle and maintenance reach the ECS/EC2 APIs privately and probe world tasks."
  }
  assert {
    condition     = contains(keys(aws_security_group_rule.endpoint_ingress), "containers-world_task") && contains(keys(aws_security_group_rule.endpoint_ingress), "telemetry-world_task")
    error_message = "ECR and Logs private DNS covers the whole VPC: world tasks need the endpoints to pull and log."
  }
  assert {
    condition     = alltrue([for env in values(module.lobby.function_environments) : env["WORLD_LAUNCHER"] == "fargate" && env["HEALTH_TIMEOUT_MS"] == "120000" && env["WORLD_TASK_PORT"] == "8001" && !contains(keys(env), "WORLD_IMAGE")])
    error_message = "Lambdas receive the Fargate launcher settings and a 120s health deadline."
  }
}

run "reject_worlds_without_image" {
  command = plan
  variables {
    bootstrap_from_source = false
    world_task_image      = ""
  }
  expect_failures = [terraform_data.world_checks]
}

run "npc_service_in_private_subnets" {
  command = plan
  variables {
    bootstrap_from_source = false
  }
  assert {
    condition     = module.npc.service_network.assign_public_ip == false && module.npc.service_network.desired_count == 2 && toset(module.npc.service_network.subnet_ids) == toset(["subnet-0000000000000000a", "subnet-0000000000000000b"])
    error_message = "NPC replicas run on Fargate in both private subnets, without public IPs."
  }
  assert {
    condition     = local.interface_endpoints["containers"] == ["ecr.api", "ecr.dkr", "logs"] && contains(keys(aws_security_group_rule.endpoint_ingress), "containers-npc") && contains(keys(aws_security_group_rule.endpoint_ingress), "telemetry-npc")
    error_message = "Without NAT the NPC tasks pull images and ship logs through private endpoints."
  }
  assert {
    condition     = module.npc.autoscaling == { min = 2, max = 4 }
    error_message = "The NPC service scales between npc_min_count and npc_max_count."
  }
  assert {
    condition     = anytrue([for rule in aws_security_group.rds.ingress : rule.description == "NPC replicas take world leases" && rule.from_port == 5432 && rule.to_port == 5432])
    error_message = "NPC replicas reach RDS for their leases."
  }
  assert {
    condition     = alltrue([for env in values(module.lobby.function_environments) : !contains(keys(env), "NPC_SERVICE_URL")])
    error_message = "The Lobby no longer calls the NPC: replicas claim worlds from RDS."
  }
  assert {
    condition     = !module.npc.pushes_image && module.npc.image == var.npc_task_image
    error_message = "A supplied npc_task_image is used as is."
  }
}

run "npc_without_autoscaling" {
  command = plan
  variables {
    bootstrap_from_source   = false
    npc_autoscaling_enabled = false
  }
  assert {
    condition     = module.npc.autoscaling == null
    error_message = "The Learner Lab fallback keeps a fixed number of NPC replicas."
  }
}

run "reject_npc_without_image" {
  command = plan
  variables {
    bootstrap_from_source = false
    npc_task_image        = ""
  }
  expect_failures = [terraform_data.npc_checks]
}

run "metrics_service_behind_the_alb" {
  command = plan
  variables {
    bootstrap_from_source = false
  }
  assert {
    condition     = module.metrics.service_network.assign_public_ip == false && module.metrics.service_network.desired_count == 2 && toset(module.metrics.service_network.subnet_ids) == toset(["subnet-0000000000000000a", "subnet-0000000000000000b"])
    error_message = "Metrics replicas run on Fargate in both private subnets, without public IPs."
  }
  assert {
    condition     = aws_lb_target_group.metrics.target_type == "ip" && aws_lb_target_group.metrics.port == 3100 && one(aws_lb_target_group.metrics.health_check).path == "/health" && one(one(aws_lb_listener_rule.metrics.condition).path_pattern).values == toset(["/api/metrics*"])
    error_message = "The ALB keeps routing /api/metrics* to a target group the tasks register in by IP."
  }
  assert {
    condition     = contains(keys(aws_security_group_rule.endpoint_ingress), "containers-metrics") && !contains(keys(aws_security_group_rule.endpoint_ingress), "telemetry-metrics")
    error_message = "Without NAT the Metrics tasks pull images and ship logs through private endpoints; they do not publish telemetry."
  }
  assert {
    condition     = module.metrics.autoscaling == { min = 2, max = 4 }
    error_message = "The Metrics service scales between metrics_min_count and metrics_max_count."
  }
  assert {
    condition     = !module.metrics.pushes_image && module.metrics.image == var.metrics_task_image
    error_message = "A supplied metrics_task_image is used as is."
  }
}

run "metrics_without_autoscaling" {
  command = plan
  variables {
    bootstrap_from_source       = false
    metrics_autoscaling_enabled = false
  }
  assert {
    condition     = module.metrics.autoscaling == null && module.metrics.service_network.desired_count == 2
    error_message = "The Learner Lab fallback keeps a fixed number of Metrics replicas."
  }
}

run "reject_metrics_without_image" {
  command = plan
  variables {
    bootstrap_from_source = false
    metrics_task_image    = ""
  }
  expect_failures = [terraform_data.metrics_checks]
}

run "fargate_bootstrap_pushes_to_ecr" {
  command = plan
  variables {
    npc_task_image           = ""
    metrics_task_image       = ""
    world_task_image         = ""
    lobby_lambda_role_arn    = ""
    lobby_workflow_role_arn  = ""
    lobby_scheduler_role_arn = ""
  }
  assert {
    condition     = module.world_tasks.pushes_image
    error_message = "A source bootstrap pushes the built world image to an immutable ECR repository."
  }
  assert {
    condition     = module.npc.pushes_image
    error_message = "A source bootstrap pushes the built NPC image to an immutable ECR repository."
  }
  assert {
    condition     = module.metrics.pushes_image
    error_message = "A source bootstrap pushes the built Metrics image to an immutable ECR repository."
  }
}

