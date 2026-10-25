<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.7.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 5.79, < 6.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | 5.100.0 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_endpoints"></a> [endpoints](#module\_endpoints) | terraform-aws-modules/vpc/aws//modules/vpc-endpoints | 5.21.0 |
| <a name="module_vpc"></a> [vpc](#module\_vpc) | terraform-aws-modules/vpc/aws | 5.21.0 |

## Resources

| Name | Type |
|------|------|
| [aws_security_group.endpoints](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/security_group) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_azs"></a> [azs](#input\_azs) | Availability Zones, in order. Subnet i of every tier lands in azs[i]. | `list(string)` | n/a | yes |
| <a name="input_database_client_tiers"></a> [database\_client\_tiers](#input\_database\_client\_tiers) | Tiers whose subnets may open connections to the database subnets. | `list(string)` | <pre>[<br/>  "private"<br/>]</pre> | no |
| <a name="input_database_port"></a> [database\_port](#input\_database\_port) | n/a | `number` | `5432` | no |
| <a name="input_elasticache_client_tiers"></a> [elasticache\_client\_tiers](#input\_elasticache\_client\_tiers) | Tiers whose subnets may open connections to the cache subnets. | `list(string)` | <pre>[<br/>  "private",<br/>  "public"<br/>]</pre> | no |
| <a name="input_elasticache_port"></a> [elasticache\_port](#input\_elasticache\_port) | n/a | `number` | `6379` | no |
| <a name="input_elasticache_replication"></a> [elasticache\_replication](#input\_elasticache\_replication) | Allow traffic between the cache subnets themselves, needed by a primary and its replicas in different subnets. | `bool` | `true` | no |
| <a name="input_gateway_endpoints"></a> [gateway\_endpoints](#input\_gateway\_endpoints) | Services reached through gateway endpoints from the public and private route tables. | `list(string)` | <pre>[<br/>  "s3",<br/>  "dynamodb"<br/>]</pre> | no |
| <a name="input_interface_endpoints"></a> [interface\_endpoints](#input\_interface\_endpoints) | Interface endpoints grouped by who consumes them, as group => services. Each group gets its own security group, with no ingress: the caller adds rules for its consumers. | `map(list(string))` | `{}` | no |
| <a name="input_name"></a> [name](#input\_name) | Prefix for every resource name in the network. | `string` | n/a | yes |
| <a name="input_region"></a> [region](#input\_region) | AWS region, used to build the VPC endpoint service names. | `string` | n/a | yes |
| <a name="input_subnet_cidrs"></a> [subnet\_cidrs](#input\_subnet\_cidrs) | CIDR blocks per tier. Public subnets reach the Internet Gateway; the rest have no route to the Internet. | <pre>object({<br/>    public      = list(string)<br/>    private     = list(string)<br/>    database    = list(string)<br/>    elasticache = list(string)<br/>  })</pre> | n/a | yes |
| <a name="input_vpc_cidr"></a> [vpc\_cidr](#input\_vpc\_cidr) | n/a | `string` | `"10.0.0.0/16"` | no |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_database_route_table_ids"></a> [database\_route\_table\_ids](#output\_database\_route\_table\_ids) | n/a |
| <a name="output_database_subnet_ids"></a> [database\_subnet\_ids](#output\_database\_subnet\_ids) | n/a |
| <a name="output_elasticache_route_table_ids"></a> [elasticache\_route\_table\_ids](#output\_elasticache\_route\_table\_ids) | n/a |
| <a name="output_elasticache_subnet_ids"></a> [elasticache\_subnet\_ids](#output\_elasticache\_subnet\_ids) | n/a |
| <a name="output_endpoint_security_group_ids"></a> [endpoint\_security\_group\_ids](#output\_endpoint\_security\_group\_ids) | Security group of each interface endpoint group, as group => id. |
| <a name="output_private_route_table_ids"></a> [private\_route\_table\_ids](#output\_private\_route\_table\_ids) | n/a |
| <a name="output_private_subnet_ids"></a> [private\_subnet\_ids](#output\_private\_subnet\_ids) | Application subnets without Internet access, in the order of var.azs. |
| <a name="output_public_route_table_ids"></a> [public\_route\_table\_ids](#output\_public\_route\_table\_ids) | n/a |
| <a name="output_public_subnet_ids"></a> [public\_subnet\_ids](#output\_public\_subnet\_ids) | Public subnets, in the order of var.azs. |
| <a name="output_s3_prefix_list_id"></a> [s3\_prefix\_list\_id](#output\_s3\_prefix\_list\_id) | Prefix list of the S3 gateway endpoint, for HTTPS egress rules towards S3. |
| <a name="output_vpc_cidr_block"></a> [vpc\_cidr\_block](#output\_vpc\_cidr\_block) | n/a |
| <a name="output_vpc_id"></a> [vpc\_id](#output\_vpc\_id) | n/a |
<!-- END_TF_DOCS -->