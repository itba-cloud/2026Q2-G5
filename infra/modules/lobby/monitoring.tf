# Alarms are provisioned without notification destinations; operators may wire
# existing notification policies. No external messages are sent by this module.
resource "aws_cloudwatch_log_metric_filter" "lobby_maintenance" {
  for_each = {
    Completed  = { field = "1", unit = "Count" }
    Pending    = { field = "$.pending", unit = "Count" }
    Oldest     = { field = "$.oldest_seconds", unit = "Seconds" }
    ItemErrors = { field = "$.errors", unit = "Count" }
  }
  name           = "${var.name}-maintenance-${each.key}"
  log_group_name = aws_cloudwatch_log_group.lobby_lambda["maintenance"].name
  pattern        = "{ $.event = \"maintenance.completed\" }"
  metric_transformation {
    name      = "${var.name}-${each.key}"
    namespace = "ElasticWorlds/LobbyMaintenance"
    value     = each.value.field
    unit      = each.value.unit
  }
}

resource "aws_cloudwatch_metric_alarm" "lobby_maintenance_progress" {
  count               = var.maintenance_enabled ? 1 : 0
  alarm_name          = "${var.name}-lobby-maintenance-missing"
  namespace           = "ElasticWorlds/LobbyMaintenance"
  metric_name         = "${var.name}-Completed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
}

resource "aws_cloudwatch_metric_alarm" "lobby_maintenance_errors" {
  for_each            = toset(["Errors", "Throttles", "AsyncEventsDropped"])
  alarm_name          = "${var.name}-lobby-maintenance-${each.key}"
  namespace           = "AWS/Lambda"
  metric_name         = each.key
  dimensions          = { FunctionName = aws_lambda_function.lobby_maintenance.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "lobby_maintenance_backlog" {
  alarm_name          = "${var.name}-lobby-maintenance-old-pending"
  namespace           = "ElasticWorlds/LobbyMaintenance"
  metric_name         = "${var.name}-Oldest"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = 900
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "lobby_maintenance_items" {
  alarm_name          = "${var.name}-lobby-maintenance-item-errors"
  namespace           = "ElasticWorlds/LobbyMaintenance"
  metric_name         = "${var.name}-ItemErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "lobby_schedule_delivery" {
  alarm_name          = "${var.name}-lobby-schedule-delivery"
  namespace           = "AWS/Scheduler"
  metric_name         = "TargetErrorCount"
  dimensions          = { ScheduleGroup = aws_scheduler_schedule_group.lobby.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
}
