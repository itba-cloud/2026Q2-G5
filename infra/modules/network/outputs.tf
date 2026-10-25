output "vpc_id" {
  value = module.vpc.vpc_id
}

output "vpc_cidr_block" {
  value = module.vpc.vpc_cidr_block
}

output "public_subnet_ids" {
  description = "Public subnets, in the order of var.azs."
  value       = module.vpc.public_subnets
}

output "private_subnet_ids" {
  description = "Application subnets without Internet access, in the order of var.azs."
  value       = module.vpc.private_subnets
}

output "database_subnet_ids" {
  value = module.vpc.database_subnets
}

output "elasticache_subnet_ids" {
  value = module.vpc.elasticache_subnets
}

output "public_route_table_ids" {
  value = module.vpc.public_route_table_ids
}

output "private_route_table_ids" {
  value = module.vpc.private_route_table_ids
}

output "database_route_table_ids" {
  value = module.vpc.database_route_table_ids
}

output "elasticache_route_table_ids" {
  value = module.vpc.elasticache_route_table_ids
}

output "s3_prefix_list_id" {
  description = "Prefix list of the S3 gateway endpoint, for HTTPS egress rules towards S3."
  value       = module.endpoints.endpoints["s3"].prefix_list_id
}

output "endpoint_security_group_ids" {
  description = "Security group of each interface endpoint group, as group => id."
  value       = { for group, sg in aws_security_group.endpoints : group => sg.id }
}
