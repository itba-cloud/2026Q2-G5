# terraform test uses a mocked provider: it never creates AWS resources. Runs use
# apply so the mock fills in computed values; nothing reaches AWS.
mock_provider "aws" {}

variables {
  name   = "ewo-test"
  region = "us-east-1"
  azs    = ["us-east-1a", "us-east-1b"]
  subnet_cidrs = {
    public      = ["10.0.0.0/24", "10.0.1.0/24"]
    private     = ["10.0.10.0/24", "10.0.11.0/24"]
    database    = ["10.0.20.0/24", "10.0.21.0/24"]
    elasticache = ["10.0.30.0/24", "10.0.31.0/24"]
  }
  interface_endpoints = {
    telemetry  = ["kinesis-streams"]
    containers = ["ecr.api", "ecr.dkr", "logs"]
  }
}

run "one_route_table_per_tier_without_nat" {
  assert {
    condition     = length(module.vpc.natgw_ids) == 0 && length(module.vpc.nat_ids) == 0
    error_message = "single_nat_gateway must not create a NAT Gateway or an EIP while enable_nat_gateway is false."
  }
  assert {
    condition = (
      length(module.vpc.public_route_table_ids) == 1 && length(module.vpc.private_route_table_ids) == 1 &&
      length(module.vpc.database_route_table_ids) == 1 && length(module.vpc.elasticache_route_table_ids) == 1
    )
    error_message = "Every tier shares a single route table across both AZs."
  }
  assert {
    condition = (
      length(module.vpc.public_subnets) == 2 && length(module.vpc.private_subnets) == 2 &&
      length(module.vpc.database_subnets) == 2 && length(module.vpc.elasticache_subnets) == 2
    )
    error_message = "Eight subnets: two of each tier, one per AZ."
  }
}

run "data_tier_acls" {
  assert {
    condition = local.database_acl_inbound == [
      { rule_number = 100, rule_action = "allow", protocol = "tcp", from_port = 5432, to_port = 5432, cidr_block = "10.0.10.0/24" },
      { rule_number = 110, rule_action = "allow", protocol = "tcp", from_port = 5432, to_port = 5432, cidr_block = "10.0.11.0/24" },
    ]
    error_message = "RDS accepts PostgreSQL only from the private subnets."
  }
  assert {
    condition = (
      [for rule in local.elasticache_acl_inbound : rule.cidr_block if rule.rule_number < 300] == ["10.0.10.0/24", "10.0.11.0/24", "10.0.0.0/24", "10.0.1.0/24"] &&
      [for rule in local.elasticache_acl_inbound : rule.rule_number if rule.rule_number < 300] == [100, 110, 120, 130] &&
      alltrue([for rule in local.elasticache_acl_inbound : rule.from_port == 6379 && rule.to_port == 6379 if rule.rule_number < 400])
    )
    error_message = "Redis accepts 6379 from the private and public subnets."
  }
  assert {
    condition = (
      [for rule in local.elasticache_acl_inbound : [rule.rule_number, rule.cidr_block, rule.from_port, rule.to_port] if rule.rule_number >= 300] == [
        [300, "10.0.30.0/24", 6379, 6379], [310, "10.0.31.0/24", 6379, 6379],
        [400, "10.0.30.0/24", 1024, 65535], [410, "10.0.31.0/24", 1024, 65535],
      ] &&
      [for rule in local.elasticache_acl_outbound : [rule.rule_number, rule.cidr_block] if rule.rule_number >= 300] == [
        [300, "10.0.30.0/24"], [310, "10.0.31.0/24"],
      ]
    )
    error_message = "The cache subnets reach each other for replication, in both directions."
  }
  assert {
    condition = alltrue([
      for rule in concat(local.database_acl_outbound, local.elasticache_acl_outbound) : rule.from_port == 1024 && rule.to_port == 65535
    ]) && length(local.database_acl_outbound) == 2 && length(local.elasticache_acl_outbound) == 6
    error_message = "Every inbound rule has its return rule to the client ephemeral ports."
  }
  assert {
    condition     = module.vpc.database_network_acl_id != null && module.vpc.elasticache_network_acl_id != null
    error_message = "Database and cache subnets use dedicated network ACLs."
  }
}

run "cache_replication_can_be_disabled" {
  variables {
    elasticache_replication = false
  }
  assert {
    condition     = length(local.elasticache_acl_inbound) == 4 && length(local.elasticache_acl_outbound) == 4
    error_message = "Without replication only the client rules remain."
  }
}

run "endpoints_by_consumer_group" {
  assert {
    condition     = toset(keys(module.endpoints.endpoints)) == toset(["s3", "dynamodb", "kinesis-streams", "ecr.api", "ecr.dkr", "logs"])
    error_message = "Gateway endpoints for S3 and DynamoDB plus every requested interface endpoint."
  }
  assert {
    condition = alltrue([
      for service in ["kinesis-streams", "ecr.api", "ecr.dkr", "logs"] :
      module.endpoints.endpoints[service].vpc_endpoint_type == "Interface" && module.endpoints.endpoints[service].private_dns_enabled
    ]) && module.endpoints.endpoints["s3"].vpc_endpoint_type == "Gateway" && module.endpoints.endpoints["dynamodb"].vpc_endpoint_type == "Gateway"
    error_message = "Interface endpoints use private DNS so clients need no configuration."
  }
  assert {
    condition     = toset(keys(aws_security_group.endpoints)) == toset(["telemetry", "containers"]) && alltrue([for sg in aws_security_group.endpoints : length(sg.ingress) == 0])
    error_message = "One security group per consumer group, without inline rules: the caller adds them."
  }
}

run "no_iam_roles" {
  assert {
    condition     = module.vpc.vpc_flow_log_cloudwatch_iam_role_arn == ""
    error_message = "The Learner Lab cannot create IAM roles: Flow Logs stay off."
  }
}

run "reject_unknown_client_tier" {
  command = plan
  variables {
    database_client_tiers = ["database"]
  }
  expect_failures = [var.database_client_tiers]
}

run "reject_s3_without_gateway" {
  command = plan
  variables {
    gateway_endpoints = ["dynamodb"]
  }
  expect_failures = [var.gateway_endpoints]
}
