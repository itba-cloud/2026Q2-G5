output "target_group_arns" {
  description = "Lambda target group of the public and internal functions, for the ALB listeners."
  value       = { for name, group in aws_lb_target_group.lobby_lambda : name => group.arn }
}

output "workflows" {
  value = { for name, workflow in aws_sfn_state_machine.lobby : name => workflow.state_machine_version_arn }
}

output "function_names" {
  value = merge({ for name, fn in aws_lambda_function.lobby_http : name => fn.function_name }, {
    lifecycle   = aws_lambda_function.lobby_lifecycle.function_name
    maintenance = aws_lambda_function.lobby_maintenance.function_name
  })
}

output "maintenance_alias_arn" {
  value = aws_lambda_alias.lobby_maintenance.arn
}

output "maintenance_schedule" {
  value = {
    state      = aws_scheduler_schedule.lobby_maintenance.state
    expression = aws_scheduler_schedule.lobby_maintenance.schedule_expression
  }
}

output "function_packages" {
  description = "Deployment package of each function, to check that none shares a zip."
  value = merge({ for name, fn in aws_lambda_function.lobby_http : name => fn.filename }, {
    lifecycle   = aws_lambda_function.lobby_lifecycle.filename
    maintenance = aws_lambda_function.lobby_maintenance.filename
    migrate     = aws_lambda_function.lobby_migrate.filename
  })
}

output "function_environments" {
  description = "Environment of each function, as deployed."
  value = merge({ for name, fn in aws_lambda_function.lobby_http : name => fn.environment[0].variables }, {
    lifecycle   = aws_lambda_function.lobby_lifecycle.environment[0].variables
    maintenance = aws_lambda_function.lobby_maintenance.environment[0].variables
    migrate     = aws_lambda_function.lobby_migrate.environment[0].variables
  })
}

output "function_subnet_ids" {
  description = "Subnets each function attaches to."
  value = merge({ for name, fn in aws_lambda_function.lobby_http : name => fn.vpc_config[0].subnet_ids }, {
    lifecycle   = aws_lambda_function.lobby_lifecycle.vpc_config[0].subnet_ids
    maintenance = aws_lambda_function.lobby_maintenance.vpc_config[0].subnet_ids
    migrate     = aws_lambda_function.lobby_migrate.vpc_config[0].subnet_ids
  })
}
