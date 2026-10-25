<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.7.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 5.93, < 6.0 |

## Providers

No providers.

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_postgres"></a> [postgres](#module\_postgres) | terraform-aws-modules/rds/aws | 6.13.1 |
| <a name="module_redis"></a> [redis](#module\_redis) | terraform-aws-modules/elasticache/aws | 1.11.2 |

## Resources

No resources.

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_allocated_storage"></a> [allocated\_storage](#input\_allocated\_storage) | n/a | `number` | `20` | no |
| <a name="input_cache_engine_version"></a> [cache\_engine\_version](#input\_cache\_engine\_version) | n/a | `string` | `"7.1"` | no |
| <a name="input_cache_node_type"></a> [cache\_node\_type](#input\_cache\_node\_type) | n/a | `string` | `"cache.t3.micro"` | no |
| <a name="input_cache_security_group_ids"></a> [cache\_security\_group\_ids](#input\_cache\_security\_group\_ids) | n/a | `list(string)` | n/a | yes |
| <a name="input_cache_subnet_ids"></a> [cache\_subnet\_ids](#input\_cache\_subnet\_ids) | Cache subnets, one per Availability Zone: the primary and the replica land in different ones. | `list(string)` | n/a | yes |
| <a name="input_db_name"></a> [db\_name](#input\_db\_name) | n/a | `string` | `"cloudgame"` | no |
| <a name="input_engine_version"></a> [engine\_version](#input\_engine\_version) | n/a | `string` | `"18.3"` | no |
| <a name="input_instance_class"></a> [instance\_class](#input\_instance\_class) | n/a | `string` | `"db.t3.micro"` | no |
| <a name="input_manage_master_user_password"></a> [manage\_master\_user\_password](#input\_manage\_master\_user\_password) | Let RDS generate the master password and keep it in Secrets Manager. | `bool` | `false` | no |
| <a name="input_multi_az"></a> [multi\_az](#input\_multi\_az) | Keep a synchronous standby in another subnet's AZ; RDS fails over to it automatically. | `bool` | `false` | no |
| <a name="input_name"></a> [name](#input\_name) | Prefix for the database identifier and its subnet group. | `string` | n/a | yes |
| <a name="input_password"></a> [password](#input\_password) | Master password. Ignored when manage\_master\_user\_password is true. | `string` | `null` | no |
| <a name="input_security_group_ids"></a> [security\_group\_ids](#input\_security\_group\_ids) | n/a | `list(string)` | n/a | yes |
| <a name="input_subnet_ids"></a> [subnet\_ids](#input\_subnet\_ids) | Database subnets, in at least two Availability Zones (RDS requires it even without Multi-AZ). | `list(string)` | n/a | yes |
| <a name="input_username"></a> [username](#input\_username) | n/a | `string` | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_address"></a> [address](#output\_address) | n/a |
| <a name="output_db_name"></a> [db\_name](#output\_db\_name) | n/a |
| <a name="output_master_user_secret_arn"></a> [master\_user\_secret\_arn](#output\_master\_user\_secret\_arn) | Secrets Manager secret with the master credentials; null unless manage\_master\_user\_password is true. |
| <a name="output_multi_az"></a> [multi\_az](#output\_multi\_az) | n/a |
| <a name="output_port"></a> [port](#output\_port) | n/a |
| <a name="output_redis_primary_endpoint"></a> [redis\_primary\_endpoint](#output\_redis\_primary\_endpoint) | Primary endpoint; after a failover it resolves to the new primary. |
| <a name="output_redis_url"></a> [redis\_url](#output\_redis\_url) | TLS URL for ioredis. |
| <a name="output_resource_id"></a> [resource\_id](#output\_resource\_id) | Changes only when the instance is replaced; used to rerun migrations on a new database. |
| <a name="output_subnet_group_name"></a> [subnet\_group\_name](#output\_subnet\_group\_name) | n/a |
<!-- END_TF_DOCS -->