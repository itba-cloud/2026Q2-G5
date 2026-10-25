# Disposable permission probe, separate from the application root/state.
terraform {
  required_version = "= 1.16.1"
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 5.100.0" }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = var.probe_name, ManagedBy = "terraform-permission-probe", Disposable = "true" }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "probe_name" {
  type = string
  validation {
    condition     = can(regex("^ewo-permisos-[a-z0-9-]+$", var.probe_name)) && length(var.probe_name) <= 35
    error_message = "Use a unique ewo-permisos- prefix, at most 35 characters."
  }
}
variable "db_password" {
  type      = string
  sensitive = true
}

data "aws_availability_zones" "available" { state = "available" }
data "aws_iam_role" "lab" { name = "LabRole" }

resource "aws_vpc" "probe" {
  cidr_block = "10.254.0.0/16"
  tags       = { Name = var.probe_name }
}
resource "aws_subnet" "probe" {
  count             = 2
  vpc_id            = aws_vpc.probe.id
  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = cidrsubnet(aws_vpc.probe.cidr_block, 8, count.index)
}
resource "aws_security_group" "probe" {
  name        = var.probe_name
  description = "Isolated permission probe; no incoming client access or Internet route"
  vpc_id      = aws_vpc.probe.id
  ingress {
    from_port = 6379
    to_port   = 6379
    protocol  = "tcp"
    self      = true
  }
}

resource "aws_secretsmanager_secret" "probe" {
  name                    = var.probe_name
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret_version" "probe" {
  secret_id     = aws_secretsmanager_secret.probe.id
  secret_string = jsonencode({ probe = true })
}

resource "aws_db_subnet_group" "probe" {
  name       = var.probe_name
  subnet_ids = aws_subnet.probe[*].id
}
resource "aws_db_instance" "probe" {
  identifier              = var.probe_name
  engine                  = "postgres"
  engine_version          = "18.3"
  instance_class          = "db.t3.micro"
  allocated_storage       = 20
  storage_type            = "gp3"
  storage_encrypted       = true
  username                = "ewo_probe"
  password                = var.db_password
  multi_az                = true
  publicly_accessible     = false
  db_subnet_group_name    = aws_db_subnet_group.probe.name
  vpc_security_group_ids  = [aws_security_group.probe.id]
  backup_retention_period = 1
  skip_final_snapshot     = true
  deletion_protection     = false
}

resource "aws_elasticache_subnet_group" "probe" {
  name       = var.probe_name
  subnet_ids = aws_subnet.probe[*].id
}
resource "aws_elasticache_replication_group" "probe" {
  replication_group_id        = var.probe_name
  description                 = "Disposable permission probe"
  engine                      = "redis"
  engine_version              = "7.1"
  node_type                   = "cache.t3.micro"
  num_cache_clusters          = 2
  automatic_failover_enabled  = true
  multi_az_enabled            = true
  preferred_cache_cluster_azs = slice(data.aws_availability_zones.available.names, 0, 2)
  subnet_group_name           = aws_elasticache_subnet_group.probe.name
  security_group_ids          = [aws_security_group.probe.id]
  at_rest_encryption_enabled  = true
  transit_encryption_enabled  = true
  snapshot_retention_limit    = 0
}

resource "aws_ecr_repository" "probe" {
  name         = var.probe_name
  force_delete = true
}
resource "aws_cloudwatch_log_group" "probe" {
  name              = "/ewo-permisos/${var.probe_name}"
  retention_in_days = 1
}
resource "aws_ecs_cluster" "probe" { name = var.probe_name }
resource "aws_ecs_task_definition" "probe" {
  family                   = var.probe_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = data.aws_iam_role.lab.arn
  task_role_arn            = data.aws_iam_role.lab.arn
  container_definitions = jsonencode([{
    name = "probe", image = "${aws_ecr_repository.probe.repository_url}:probe", essential = true
  }])
}
resource "aws_ecs_service" "probe" {
  name            = var.probe_name
  cluster         = aws_ecs_cluster.probe.id
  task_definition = aws_ecs_task_definition.probe.arn
  desired_count   = 0
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.probe[*].id
    security_groups  = [aws_security_group.probe.id]
    assign_public_ip = false
  }
}
resource "aws_appautoscaling_target" "probe" {
  max_capacity       = 2
  min_capacity       = 0
  resource_id        = "service/${aws_ecs_cluster.probe.name}/${aws_ecs_service.probe.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}
resource "aws_appautoscaling_policy" "probe" {
  name               = var.probe_name
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.probe.resource_id
  scalable_dimension = aws_appautoscaling_target.probe.scalable_dimension
  service_namespace  = aws_appautoscaling_target.probe.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value = 70
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}

output "probe_name" { value = var.probe_name }
output "secret_id" { value = aws_secretsmanager_secret.probe.id }
output "rds_configuration" {
  value = { engine = aws_db_instance.probe.engine_version, class = aws_db_instance.probe.instance_class, multi_az = aws_db_instance.probe.multi_az }
}
output "cache_configuration" {
  value = { engine = aws_elasticache_replication_group.probe.engine_version, node_type = aws_elasticache_replication_group.probe.node_type, multi_az = aws_elasticache_replication_group.probe.multi_az_enabled }
}
