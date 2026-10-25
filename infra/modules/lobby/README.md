<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.7.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | ~> 5.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | 5.100.0 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [aws_cloudwatch_log_group.lobby_lambda](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_cloudwatch_log_metric_filter.lobby_maintenance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_metric_filter) | resource |
| [aws_cloudwatch_metric_alarm.lobby_maintenance_backlog](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_metric_alarm) | resource |
| [aws_cloudwatch_metric_alarm.lobby_maintenance_errors](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_metric_alarm) | resource |
| [aws_cloudwatch_metric_alarm.lobby_maintenance_items](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_metric_alarm) | resource |
| [aws_cloudwatch_metric_alarm.lobby_maintenance_progress](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_metric_alarm) | resource |
| [aws_cloudwatch_metric_alarm.lobby_schedule_delivery](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_metric_alarm) | resource |
| [aws_lambda_alias.lobby_http](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_alias) | resource |
| [aws_lambda_alias.lobby_maintenance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_alias) | resource |
| [aws_lambda_function.lobby_http](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_function.lobby_lifecycle](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_function.lobby_maintenance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_function.lobby_migrate](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_function_event_invoke_config.lobby_maintenance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function_event_invoke_config) | resource |
| [aws_lambda_invocation.lobby_migrate](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_invocation) | resource |
| [aws_lambda_permission.lobby_alb](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_permission) | resource |
| [aws_lb_target_group.lobby_lambda](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lb_target_group) | resource |
| [aws_lb_target_group_attachment.lobby_lambda](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lb_target_group_attachment) | resource |
| [aws_scheduler_schedule.lobby_maintenance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/scheduler_schedule) | resource |
| [aws_scheduler_schedule_group.lobby](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/scheduler_schedule_group) | resource |
| [aws_sfn_state_machine.lobby](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sfn_state_machine) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_database_resource_id"></a> [database\_resource\_id](#input\_database\_resource\_id) | RDS resource id; a new database reruns the migration Lambda. | `string` | n/a | yes |
| <a name="input_environment"></a> [environment](#input\_environment) | Application settings shared by every function. | `map(string)` | n/a | yes |
| <a name="input_lambda_concurrency"></a> [lambda\_concurrency](#input\_lambda\_concurrency) | Reserved concurrency of the public, internal and lifecycle functions. | `number` | n/a | yes |
| <a name="input_lambda_role_arn"></a> [lambda\_role\_arn](#input\_lambda\_role\_arn) | Existing role trusted by Lambda. The Learner Lab does not allow creating roles. | `string` | n/a | yes |
| <a name="input_lambda_zips"></a> [lambda\_zips](#input\_lambda\_zips) | Deployment package of each function: public, internal, lifecycle, maintenance and migrate. | `map(string)` | n/a | yes |
| <a name="input_maintenance_enabled"></a> [maintenance\_enabled](#input\_maintenance\_enabled) | n/a | `bool` | n/a | yes |
| <a name="input_maintenance_interval_minutes"></a> [maintenance\_interval\_minutes](#input\_maintenance\_interval\_minutes) | n/a | `number` | n/a | yes |
| <a name="input_migrations_dir"></a> [migrations\_dir](#input\_migrations\_dir) | Directory with the SQL migrations; a change reruns the migration Lambda. | `string` | n/a | yes |
| <a name="input_name"></a> [name](#input\_name) | Prefix for every Lobby function, workflow, schedule and alarm. | `string` | n/a | yes |
| <a name="input_scheduler_role_arn"></a> [scheduler\_role\_arn](#input\_scheduler\_role\_arn) | Existing role trusted by scheduler.amazonaws.com. | `string` | n/a | yes |
| <a name="input_security_group_ids"></a> [security\_group\_ids](#input\_security\_group\_ids) | Security group of each function: public, internal, lifecycle and maintenance. The migration Lambda uses lifecycle's. | `map(string)` | n/a | yes |
| <a name="input_subnet_ids"></a> [subnet\_ids](#input\_subnet\_ids) | Private subnets the Lambdas attach to, one per Availability Zone. | `list(string)` | n/a | yes |
| <a name="input_workflow_role_arn"></a> [workflow\_role\_arn](#input\_workflow\_role\_arn) | Existing role trusted by states.amazonaws.com. | `string` | n/a | yes |
| <a name="input_workflows_dir"></a> [workflows\_dir](#input\_workflows\_dir) | Directory with the start-world and stop-world state machine definitions. | `string` | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_function_environments"></a> [function\_environments](#output\_function\_environments) | Environment of each function, as deployed. |
| <a name="output_function_names"></a> [function\_names](#output\_function\_names) | n/a |
| <a name="output_function_packages"></a> [function\_packages](#output\_function\_packages) | Deployment package of each function, to check that none shares a zip. |
| <a name="output_function_subnet_ids"></a> [function\_subnet\_ids](#output\_function\_subnet\_ids) | Subnets each function attaches to. |
| <a name="output_maintenance_alias_arn"></a> [maintenance\_alias\_arn](#output\_maintenance\_alias\_arn) | n/a |
| <a name="output_maintenance_schedule"></a> [maintenance\_schedule](#output\_maintenance\_schedule) | n/a |
| <a name="output_target_group_arns"></a> [target\_group\_arns](#output\_target\_group\_arns) | Lambda target group of the public and internal functions, for the ALB listeners. |
| <a name="output_workflows"></a> [workflows](#output\_workflows) | n/a |
<!-- END_TF_DOCS -->