output "client_website_url" {
  description = "Public S3 static website URL."
  value       = "http://${aws_s3_bucket_website_configuration.client.website_endpoint}"
}

output "alb_url" {
  description = "Public API URL for the Lobby and Metrics path."
  value       = "http://${aws_lb.main.dns_name}"
}

output "snapshot_bucket_name" {
  description = "Private S3 bucket used by World Service snapshots."
  value       = data.aws_s3_bucket.snapshots.bucket
}

output "rds_endpoint" {
  description = "Private PostgreSQL endpoint used by the Lobby."
  value       = module.data.address
}

output "internal_alb_url" {
  description = "Private API URL for internal communication (world status reports, shutdowns, metrics)."
  value       = "http://${aws_lb.internal.dns_name}"
}

output "telemetry_stream_name" {
  description = "Kinesis Data Stream that World Service and NPC publish their samples to."
  value       = local.telemetry_stream_name
}

output "telemetry_table_name" {
  description = "DynamoDB table written by the Flink job and read by the Metrics Service."
  value       = module.telemetry.table_name
}

output "flink_application_name" {
  description = "Managed Service for Apache Flink application. Check it with: aws kinesisanalyticsv2 describe-application --application-name <name>"
  value       = module.telemetry.application_name
}

output "metrics_service" {
  description = "ECS service that runs the stateless Metrics Service replicas in the private subnets. Check them with: aws ecs describe-services --cluster <cluster> --services <service>"
  value = {
    cluster = module.metrics.cluster_name
    service = module.metrics.service_name
    image   = module.metrics.image
  }
}

output "network" {
  description = "Stable network contract for operators and future cache/database modules."
  value = {
    vpc_id                 = module.network.vpc_id
    vpc_cidr               = module.network.vpc_cidr_block
    public_subnet_ids      = module.network.public_subnet_ids
    application_subnet_ids = module.network.private_subnet_ids
    database_subnet_ids    = module.network.database_subnet_ids
    cache_subnet_ids       = module.network.elasticache_subnet_ids
    route_table_ids = {
      public   = module.network.public_route_table_ids
      private  = module.network.private_route_table_ids
      database = module.network.database_route_table_ids
      cache    = module.network.elasticache_route_table_ids
    }
    endpoint_security_group_ids = module.network.endpoint_security_group_ids
  }
}

output "metrics_password_secret_arn" {
  description = "Secret with the Metrics dashboard password. Read it with: aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text"
  value       = aws_secretsmanager_secret.metrics_password.arn
}

output "db_secret_arn" {
  description = "Secret RDS manages for the master user; RDS rotates it every 7 days."
  value       = module.data.master_user_secret_arn
}
