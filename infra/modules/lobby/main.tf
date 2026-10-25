locals {
  workflow_env = {
    START_WORKFLOW_ARN = aws_sfn_state_machine.lobby["start"].state_machine_version_arn
    STOP_WORKFLOW_ARN  = aws_sfn_state_machine.lobby["stop"].state_machine_version_arn
  }
}

resource "aws_cloudwatch_log_group" "lobby_lambda" {
  for_each          = toset(["public", "internal", "lifecycle", "maintenance", "migrate"])
  name              = "/aws/lambda/${var.name}-lobby-${each.key}"
  retention_in_days = 14
}

# Kept separate from HTTP functions to avoid the workflow-version dependency cycle.
resource "aws_lambda_function" "lobby_lifecycle" {
  function_name                  = "${var.name}-lobby-lifecycle"
  filename                       = var.lambda_zips.lifecycle
  source_code_hash               = filebase64sha256(var.lambda_zips.lifecycle)
  handler                        = "src/lambda/lifecycle/handler.handler"
  runtime                        = "nodejs22.x"
  role                           = var.lambda_role_arn
  memory_size                    = 256
  timeout                        = 30
  publish                        = true
  reserved_concurrent_executions = var.lambda_concurrency
  environment { variables = var.environment }
  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [var.security_group_ids["lifecycle"]]
  }
  depends_on = [aws_cloudwatch_log_group.lobby_lambda, aws_lambda_invocation.lobby_migrate]
}

resource "aws_lambda_function" "lobby_migrate" {
  function_name    = "${var.name}-lobby-migrate"
  filename         = var.lambda_zips.migrate
  source_code_hash = filebase64sha256(var.lambda_zips.migrate)
  handler          = "src/lambda/migrate/handler.handler"
  runtime          = "nodejs22.x"
  role             = var.lambda_role_arn
  memory_size      = 256
  timeout          = 60
  environment { variables = var.environment }
  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [var.security_group_ids["lifecycle"]]
  }
  depends_on = [aws_cloudwatch_log_group.lobby_lambda]
}

resource "aws_lambda_invocation" "lobby_migrate" {
  function_name = aws_lambda_function.lobby_migrate.function_name
  input         = jsonencode({ contractVersion = 1 })
  triggers = {
    schema = sha256(join("", [for f in sort(tolist(fileset(var.migrations_dir, "*.sql"))) : filesha256("${var.migrations_dir}/${f}")]))
    code   = aws_lambda_function.lobby_migrate.source_code_hash
    db     = var.database_resource_id
  }
  lifecycle_scope = "CREATE_ONLY"
}

resource "aws_sfn_state_machine" "lobby" {
  for_each = toset(["start", "stop"])
  name     = "${var.name}-world-${each.key}"
  type     = "STANDARD"
  role_arn = var.workflow_role_arn
  publish  = true
  definition = templatefile("${var.workflows_dir}/${each.key}-world.asl.json", {
    lifecycle_lambda_arn = aws_lambda_function.lobby_lifecycle.qualified_arn
  })
}

resource "aws_lambda_function" "lobby_http" {
  for_each                       = toset(["public", "internal"])
  function_name                  = "${var.name}-lobby-${each.key}"
  filename                       = var.lambda_zips[each.key]
  source_code_hash               = filebase64sha256(var.lambda_zips[each.key])
  handler                        = "src/lambda/${each.key}/handler.handler"
  runtime                        = "nodejs22.x"
  role                           = var.lambda_role_arn
  memory_size                    = 256
  timeout                        = 10
  publish                        = true
  reserved_concurrent_executions = var.lambda_concurrency
  environment { variables = merge(var.environment, local.workflow_env) }
  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [var.security_group_ids[each.key]]
  }
  depends_on = [aws_cloudwatch_log_group.lobby_lambda, aws_lambda_invocation.lobby_migrate]
}

resource "aws_lambda_alias" "lobby_http" {
  for_each         = aws_lambda_function.lobby_http
  name             = "live"
  function_name    = each.value.function_name
  function_version = each.value.version
}

resource "aws_lb_target_group" "lobby_lambda" {
  for_each                           = aws_lambda_alias.lobby_http
  name                               = "${var.name}-lbd-${each.key}"
  target_type                        = "lambda"
  lambda_multi_value_headers_enabled = false
}

resource "aws_lambda_permission" "lobby_alb" {
  for_each      = aws_lambda_alias.lobby_http
  statement_id  = "AllowLoadBalancer"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  qualifier     = each.value.name
  principal     = "elasticloadbalancing.amazonaws.com"
  source_arn    = aws_lb_target_group.lobby_lambda[each.key].arn
}

resource "aws_lb_target_group_attachment" "lobby_lambda" {
  for_each         = aws_lambda_alias.lobby_http
  target_group_arn = aws_lb_target_group.lobby_lambda[each.key].arn
  target_id        = each.value.arn
  depends_on       = [aws_lambda_permission.lobby_alb]
}

# One logical regional function, with VPC connectivity through both AZs.
resource "aws_lambda_function" "lobby_maintenance" {
  function_name                  = "${var.name}-lobby-maintenance"
  filename                       = var.lambda_zips.maintenance
  source_code_hash               = filebase64sha256(var.lambda_zips.maintenance)
  handler                        = "src/lambda/maintenance/handler.handler"
  runtime                        = "nodejs22.x"
  role                           = var.lambda_role_arn
  memory_size                    = 256
  timeout                        = 30
  publish                        = true
  reserved_concurrent_executions = 1
  environment { variables = merge(var.environment, local.workflow_env) }
  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [var.security_group_ids["maintenance"]]
  }
  depends_on = [aws_cloudwatch_log_group.lobby_lambda]
}

resource "aws_lambda_alias" "lobby_maintenance" {
  name             = "live"
  function_name    = aws_lambda_function.lobby_maintenance.function_name
  function_version = aws_lambda_function.lobby_maintenance.version
}

resource "aws_lambda_function_event_invoke_config" "lobby_maintenance" {
  function_name                = aws_lambda_function.lobby_maintenance.function_name
  qualifier                    = aws_lambda_alias.lobby_maintenance.name
  maximum_event_age_in_seconds = 120
  maximum_retry_attempts       = 1
}

resource "aws_scheduler_schedule_group" "lobby" {
  name = "${var.name}-lobby"
}

resource "aws_scheduler_schedule" "lobby_maintenance" {
  name                = "${var.name}-lobby-maintenance"
  group_name          = aws_scheduler_schedule_group.lobby.name
  state               = var.maintenance_enabled ? "ENABLED" : "DISABLED"
  schedule_expression = "rate(${var.maintenance_interval_minutes} ${var.maintenance_interval_minutes == 1 ? "minute" : "minutes"})"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_alias.lobby_maintenance.arn
    role_arn = var.scheduler_role_arn
    input    = jsonencode({ source = "lobby-maintenance", contractVersion = 1 })
    retry_policy {
      maximum_event_age_in_seconds = 120
      maximum_retry_attempts       = 1
    }
  }
  depends_on = [aws_lambda_function_event_invoke_config.lobby_maintenance]
}
