# terraform test uses a mocked provider: it never creates AWS resources. Packages
# come from lobby-service/dist/lambdas (npm --prefix lobby-service run package:lambda).
mock_provider "aws" {}

variables {
  name       = "ewo-test"
  subnet_ids = ["subnet-0000000000000000a", "subnet-0000000000000000b"]
  security_group_ids = {
    public      = "sg-00000000000000001"
    internal    = "sg-00000000000000002"
    lifecycle   = "sg-00000000000000003"
    maintenance = "sg-00000000000000004"
  }
  lambda_zips = {
    public      = "../../../lobby-service/dist/lambdas/public.zip"
    internal    = "../../../lobby-service/dist/lambdas/internal.zip"
    lifecycle   = "../../../lobby-service/dist/lambdas/lifecycle.zip"
    maintenance = "../../../lobby-service/dist/lambdas/maintenance.zip"
    migrate     = "../../../lobby-service/dist/lambdas/migrate.zip"
  }
  workflows_dir                = "../../workflows"
  migrations_dir               = "../../../lobby-service/src/store/migrations"
  lambda_role_arn              = "arn:aws:iam::123456789012:role/LambdaRole"
  workflow_role_arn            = "arn:aws:iam::123456789012:role/WorkflowRole"
  scheduler_role_arn           = "arn:aws:iam::123456789012:role/SchedulerRole"
  environment                  = { STORAGE_MODE = "rds", WORLD_LAUNCHER = "docker" }
  database_resource_id         = "db-TEST"
  lambda_concurrency           = 10
  maintenance_enabled          = true
  maintenance_interval_minutes = 1
}

run "functions_in_both_azs" {
  command = plan
  assert {
    condition = alltrue([
      for fn in concat(values(aws_lambda_function.lobby_http), [aws_lambda_function.lobby_lifecycle, aws_lambda_function.lobby_maintenance, aws_lambda_function.lobby_migrate]) :
      toset(fn.vpc_config[0].subnet_ids) == toset(var.subnet_ids) && fn.runtime == "nodejs22.x" && fn.role == var.lambda_role_arn
    ])
    error_message = "Every function runs on Node 22 with the supplied role, attached to both private subnets."
  }
  assert {
    condition = (
      aws_lambda_function.lobby_maintenance.reserved_concurrent_executions == 1 &&
      aws_lambda_function.lobby_lifecycle.reserved_concurrent_executions == 10 &&
      alltrue([for fn in aws_lambda_function.lobby_http : fn.reserved_concurrent_executions == 10])
    )
    error_message = "One maintenance run at a time; the rest share the configured concurrency."
  }
  assert {
    condition = (
      one(aws_lambda_function.lobby_http["public"].vpc_config).security_group_ids == toset(["sg-00000000000000001"]) &&
      one(aws_lambda_function.lobby_http["internal"].vpc_config).security_group_ids == toset(["sg-00000000000000002"]) &&
      one(aws_lambda_function.lobby_lifecycle.vpc_config).security_group_ids == toset(["sg-00000000000000003"]) &&
      one(aws_lambda_function.lobby_migrate.vpc_config).security_group_ids == toset(["sg-00000000000000003"]) &&
      one(aws_lambda_function.lobby_maintenance.vpc_config).security_group_ids == toset(["sg-00000000000000004"])
    )
    error_message = "Each function gets its own security group; migrations reuse the lifecycle one."
  }
  assert {
    condition = (
      aws_lambda_function.lobby_lifecycle.environment[0].variables == var.environment &&
      aws_lambda_function.lobby_migrate.environment[0].variables == var.environment &&
      alltrue([
        for fn in [aws_lambda_function.lobby_http["public"], aws_lambda_function.lobby_http["internal"], aws_lambda_function.lobby_maintenance] :
        toset(keys(fn.environment[0].variables)) == setunion(keys(var.environment), ["START_WORKFLOW_ARN", "STOP_WORKFLOW_ARN"])
      ])
    )
    error_message = "Every function gets the application settings; only the ones that start workflows also get their ARNs."
  }
  assert {
    condition     = alltrue([for group in aws_lb_target_group.lobby_lambda : group.target_type == "lambda"]) && length(aws_lb_target_group.lobby_lambda) == 2
    error_message = "The ALB reaches the public and internal functions through Lambda target groups."
  }
  assert {
    condition     = toset(keys(aws_sfn_state_machine.lobby)) == toset(["start", "stop"]) && alltrue([for sm in aws_sfn_state_machine.lobby : sm.type == "STANDARD" && sm.role_arn == var.workflow_role_arn])
    error_message = "Two standard workflows with the supplied role."
  }
}

run "schedule_and_alarms" {
  command = plan
  assert {
    condition     = aws_scheduler_schedule.lobby_maintenance.state == "ENABLED" && aws_scheduler_schedule.lobby_maintenance.schedule_expression == "rate(1 minute)" && one(aws_scheduler_schedule.lobby_maintenance.target).role_arn == var.scheduler_role_arn
    error_message = "Maintenance runs every minute through the supplied scheduler role."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.lobby_maintenance_progress) == 1 && length(aws_cloudwatch_metric_alarm.lobby_maintenance_errors) == 3 && length(aws_cloudwatch_log_metric_filter.lobby_maintenance) == 4
    error_message = "Maintenance alarms: missing runs, Lambda errors/throttles/drops, and the log metrics behind them."
  }
}

run "maintenance_disabled" {
  command = plan
  variables {
    maintenance_enabled          = false
    maintenance_interval_minutes = 2
  }
  assert {
    condition     = aws_scheduler_schedule.lobby_maintenance.state == "DISABLED" && aws_scheduler_schedule.lobby_maintenance.schedule_expression == "rate(2 minutes)" && length(aws_cloudwatch_metric_alarm.lobby_maintenance_progress) == 0
    error_message = "A paused schedule drops the missing-run alarm."
  }
}

run "reject_missing_security_group" {
  command = plan
  variables {
    security_group_ids = { public = "sg-00000000000000001" }
  }
  expect_failures = [var.security_group_ids]
}
