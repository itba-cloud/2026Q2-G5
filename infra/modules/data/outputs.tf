output "address" {
  value = module.postgres.db_instance_address
}

output "port" {
  value = module.postgres.db_instance_port
}

output "db_name" {
  value = module.postgres.db_instance_name
}

output "resource_id" {
  description = "Changes only when the instance is replaced; used to rerun migrations on a new database."
  value       = module.postgres.db_instance_resource_id
}

output "subnet_group_name" {
  value = module.postgres.db_subnet_group_id
}

output "master_user_secret_arn" {
  description = "Secrets Manager secret with the master credentials; null unless manage_master_user_password is true."
  value       = module.postgres.db_instance_master_user_secret_arn
}

output "multi_az" {
  value = var.multi_az
}

output "redis_primary_endpoint" {
  description = "Primary endpoint; after a failover it resolves to the new primary."
  value       = module.redis.replication_group_primary_endpoint_address
}

output "redis_url" {
  description = "TLS URL for ioredis."
  value       = "rediss://${module.redis.replication_group_primary_endpoint_address}:6379"
}
