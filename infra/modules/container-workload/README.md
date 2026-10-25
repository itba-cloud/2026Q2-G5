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
| <a name="provider_terraform"></a> [terraform](#provider\_terraform) | n/a |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [aws_appautoscaling_policy.cpu](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/appautoscaling_policy) | resource |
| [aws_appautoscaling_target.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/appautoscaling_target) | resource |
| [aws_cloudwatch_log_group.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_ecr_repository.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecr_repository) | resource |
| [aws_ecs_cluster.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecs_cluster) | resource |
| [aws_ecs_service.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecs_service) | resource |
| [aws_ecs_task_definition.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecs_task_definition) | resource |
| [terraform_data.image_push](https://registry.terraform.io/providers/hashicorp/terraform/latest/docs/resources/data) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_cluster_name"></a> [cluster\_name](#input\_cluster\_name) | n/a | `string` | n/a | yes |
| <a name="input_container_name"></a> [container\_name](#input\_container\_name) | Container name, also used as log stream prefix. | `string` | n/a | yes |
| <a name="input_cpu"></a> [cpu](#input\_cpu) | n/a | `number` | n/a | yes |
| <a name="input_environment"></a> [environment](#input\_environment) | n/a | `map(string)` | `{}` | no |
| <a name="input_execution_role_arn"></a> [execution\_role\_arn](#input\_execution\_role\_arn) | Existing role ECS uses to pull the image and write logs. The Learner Lab does not allow creating roles. | `string` | n/a | yes |
| <a name="input_health_check"></a> [health\_check](#input\_health\_check) | Container health check, in the ECS task definition format. Null skips it. | `any` | `null` | no |
| <a name="input_image"></a> [image](#input\_image) | Image URI the tasks pull. Ignored when push\_image is set. | `string` | `""` | no |
| <a name="input_log_retention_days"></a> [log\_retention\_days](#input\_log\_retention\_days) | n/a | `number` | `14` | no |
| <a name="input_memory"></a> [memory](#input\_memory) | n/a | `number` | n/a | yes |
| <a name="input_name"></a> [name](#input\_name) | Task definition family, ECR repository name and log group suffix (/ecs/<name>). | `string` | n/a | yes |
| <a name="input_port"></a> [port](#input\_port) | n/a | `number` | n/a | yes |
| <a name="input_push_image"></a> [push\_image](#input\_push\_image) | Create an immutable ECR repository and push source\_image to it. Fargate tasks without Internet access can only pull from ECR. | <pre>object({<br/>    source_image = string<br/>    script       = string<br/>    account_id   = string<br/>  })</pre> | `null` | no |
| <a name="input_region"></a> [region](#input\_region) | n/a | `string` | n/a | yes |
| <a name="input_service"></a> [service](#input\_service) | Run the task as an ECS service. Null only registers the task definition, for tasks launched by someone else. load\_balancer registers the tasks in an existing target group (target\_type ip) and gives them a health check grace period in seconds. | <pre>object({<br/>    subnet_ids         = list(string)<br/>    security_group_ids = list(string)<br/>    assign_public_ip   = bool<br/>    desired_count      = number<br/>    load_balancer = optional(object({<br/>      target_group_arn          = string<br/>      health_check_grace_period = number<br/>    }))<br/>    autoscaling = optional(object({<br/>      min_count          = number<br/>      max_count          = number<br/>      cpu_target         = number<br/>      scale_out_cooldown = number<br/>      scale_in_cooldown  = number<br/>    }))<br/>  })</pre> | `null` | no |
| <a name="input_task_role_arn"></a> [task\_role\_arn](#input\_task\_role\_arn) | Existing role the container runs with. | `string` | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_autoscaling"></a> [autoscaling](#output\_autoscaling) | Capacity range of the service; null without autoscaling. |
| <a name="output_cluster_arn"></a> [cluster\_arn](#output\_cluster\_arn) | n/a |
| <a name="output_cluster_name"></a> [cluster\_name](#output\_cluster\_name) | n/a |
| <a name="output_container_name"></a> [container\_name](#output\_container\_name) | n/a |
| <a name="output_image"></a> [image](#output\_image) | Image URI the task definition uses. |
| <a name="output_log_group_name"></a> [log\_group\_name](#output\_log\_group\_name) | n/a |
| <a name="output_pushes_image"></a> [pushes\_image](#output\_pushes\_image) | Whether the module creates an ECR repository and pushes the source image to it. |
| <a name="output_repository_url"></a> [repository\_url](#output\_repository\_url) | ECR repository the image is pushed to; null when the image is supplied. |
| <a name="output_service_name"></a> [service\_name](#output\_service\_name) | Name of the ECS service; null without a service. |
| <a name="output_service_network"></a> [service\_network](#output\_service\_network) | Network configuration of the ECS service; null without a service. |
| <a name="output_target_group_arn"></a> [target\_group\_arn](#output\_target\_group\_arn) | Target group the service registers its tasks in; null without a load balancer. |
| <a name="output_task_definition_arn"></a> [task\_definition\_arn](#output\_task\_definition\_arn) | n/a |
<!-- END_TF_DOCS -->