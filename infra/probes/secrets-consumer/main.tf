# Disposable probe for task 03, stage 0: LabRole reads Secrets Manager from a
# private subnet with no Internet route, through the interface endpoint.
terraform {
  required_version = "= 1.16.1"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "= 5.100.0" }
    random  = { source = "hashicorp/random", version = "= 3.9.1" }
    archive = { source = "hashicorp/archive", version = "= 2.7.1" }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = var.probe_name, ManagedBy = "terraform-secrets-probe", Disposable = "true" }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "probe_name" {
  type = string
  validation {
    condition     = can(regex("^ewo-secretos-[a-z0-9-]+$", var.probe_name)) && length(var.probe_name) <= 35
    error_message = "Use a unique ewo-secretos- prefix, at most 35 characters."
  }
}

data "aws_availability_zones" "available" { state = "available" }
data "aws_iam_role" "lab" { name = "LabRole" }

# Private DNS on the endpoint requires both DNS attributes on the VPC.
resource "aws_vpc" "probe" {
  cidr_block           = "10.253.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.probe_name }
}
# No Internet gateway or NAT: the main route table only has the local route.
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.probe.id
  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = cidrsubnet(aws_vpc.probe.cidr_block, 8, count.index)
  tags              = { Name = "${var.probe_name}-private-${count.index}" }
}

# The Lambda may try any HTTPS destination, so a failed public connection
# proves the missing route, not a security group rule.
resource "aws_security_group" "consumer" {
  name        = "${var.probe_name}-consumer"
  description = "Secrets probe Lambda"
  vpc_id      = aws_vpc.probe.id
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group" "endpoint" {
  name        = "${var.probe_name}-endpoint"
  description = "Secrets Manager interface endpoint"
  vpc_id      = aws_vpc.probe.id
  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.consumer.id]
  }
}
resource "aws_security_group" "db" {
  name        = "${var.probe_name}-db"
  description = "Probe database; no client access"
  vpc_id      = aws_vpc.probe.id
}

resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.probe.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoint.id]
}

# Check 1: RDS generates the master password and stores it in Secrets Manager
# with the aws/secretsmanager key (no master_user_secret_kms_key_id given).
resource "aws_db_subnet_group" "probe" {
  name       = var.probe_name
  subnet_ids = aws_subnet.private[*].id
}
resource "aws_db_instance" "probe" {
  identifier                  = var.probe_name
  engine                      = "postgres"
  engine_version              = "18.3"
  instance_class              = "db.t3.micro"
  allocated_storage           = 20
  storage_type                = "gp3"
  storage_encrypted           = true
  username                    = "ewo_probe"
  manage_master_user_password = true
  multi_az                    = false
  publicly_accessible         = false
  db_subnet_group_name        = aws_db_subnet_group.probe.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  backup_retention_period     = 0
  skip_final_snapshot         = true
  deletion_protection         = false
  apply_immediately           = true
}

# Check 3: a Terraform-written secret whose value never reaches the state.
ephemeral "random_password" "app" {
  length  = 32
  special = false
}
resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.probe_name}-app"
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret_version" "app" {
  secret_id                = aws_secretsmanager_secret.app.id
  secret_string_wo         = jsonencode({ username = "metrics", password = ephemeral.random_password.app.result })
  secret_string_wo_version = 1
}

# Check 2: LabRole Lambda in the private subnets reads both secrets.
data "archive_file" "consumer" {
  type        = "zip"
  source_file = "${path.module}/consumer.py"
  output_path = "${path.module}/.build/consumer.zip"
}
resource "aws_cloudwatch_log_group" "consumer" {
  name              = "/aws/lambda/${var.probe_name}"
  retention_in_days = 1
}
resource "aws_lambda_function" "consumer" {
  function_name    = var.probe_name
  role             = data.aws_iam_role.lab.arn
  runtime          = "python3.13"
  handler          = "consumer.handler"
  filename         = data.archive_file.consumer.output_path
  source_code_hash = data.archive_file.consumer.output_base64sha256
  timeout          = 60
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.consumer.id]
  }
  environment {
    variables = {
      SECRET_IDS = jsonencode({
        rds = aws_db_instance.probe.master_user_secret[0].secret_arn
        app = aws_secretsmanager_secret.app.arn
      })
      VPC_CIDR = aws_vpc.probe.cidr_block
    }
  }
  depends_on = [aws_cloudwatch_log_group.consumer, aws_vpc_endpoint.secretsmanager, aws_secretsmanager_secret_version.app]
}

output "probe_name" { value = var.probe_name }
output "lambda_name" { value = aws_lambda_function.consumer.function_name }
output "rds_configuration" {
  value = {
    engine            = aws_db_instance.probe.engine_version
    class             = aws_db_instance.probe.instance_class
    multi_az          = aws_db_instance.probe.multi_az
    secret_status     = aws_db_instance.probe.master_user_secret[0].secret_status
    secret_kms_key_id = aws_db_instance.probe.master_user_secret[0].kms_key_id
  }
}
