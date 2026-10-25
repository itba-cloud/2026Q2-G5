# terraform test uses a mocked provider: it never creates AWS resources. Runs use
# apply so the mock fills in computed values; nothing reaches AWS.
mock_provider "aws" {}

variables {
  name               = "ewo-test"
  subnet_ids         = ["subnet-0000000000000000e", "subnet-0000000000000000f"]
  security_group_ids = ["sg-00000000000000005"]
  username           = "dbadmin"
  password           = "mock-database-password"

  cache_subnet_ids         = ["subnet-00000000000000010", "subnet-00000000000000011"]
  cache_security_group_ids = ["sg-00000000000000006"]
}

run "same_instance_as_before" {
  assert {
    condition = (
      module.postgres.db_instance_identifier == "ewo-test-db" && module.postgres.db_instance_engine == "postgres" &&
      module.postgres.db_instance_engine_version_actual != null && module.postgres.db_instance_name == "cloudgame" &&
      module.postgres.db_instance_username == "dbadmin" && module.postgres.db_instance_port == 5432
    )
    error_message = "PostgreSQL instance named <name>-db with the cloudgame database."
  }
  assert {
    condition     = module.postgres.db_instance_master_user_secret_arn == null
    error_message = "Without RDS management the supplied password is used and no secret is created."
  }
}

run "password_managed_by_rds" {
  # Own state: replacing a module that an earlier run applied crashes Terraform.
  state_key = "managed_password"
  variables {
    manage_master_user_password = true
    password                    = null
  }
  # The mock leaves the computed master_user_secret block empty; stand in for
  # the external module so this run checks how its secret ARN is exposed.
  override_module {
    target = module.postgres
    outputs = {
      db_instance_master_user_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-test"
    }
  }
  assert {
    condition     = output.master_user_secret_arn == "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-test"
    error_message = "RDS keeps the master password in a Secrets Manager secret, exposed as master_user_secret_arn."
  }
}

run "no_iam_roles" {
  assert {
    condition     = module.postgres.enhanced_monitoring_iam_role_arn == null
    error_message = "The Learner Lab cannot create IAM roles: Enhanced Monitoring stays off."
  }
}

run "redis_over_tls" {
  assert {
    condition     = startswith(output.redis_url, "rediss://") && endswith(output.redis_url, ":6379")
    error_message = "Clients reach Redis over TLS on the primary endpoint."
  }
  # terraform test no lee recursos de un modulo hijo: se verifica lo que exponen
  # sus salidas. La configuracion del replication group se reviso sobre el plan.
  assert {
    condition     = output.redis_primary_endpoint == module.redis.replication_group_primary_endpoint_address
    error_message = "One replication group, reached by its primary endpoint."
  }
  assert {
    condition     = module.redis.security_group_id == null && module.redis.parameter_group_id == null && length(module.redis.cloudwatch_log_groups) == 0
    error_message = "The module creates no security group, parameter group or log group of its own."
  }
  assert {
    condition     = module.redis.subnet_group_name == "ewo-test-redis"
    error_message = "The cache nodes use their own subnet group over the cache subnets."
  }
}

run "reject_single_cache_subnet" {
  command = plan
  variables {
    cache_subnet_ids = ["subnet-00000000000000010"]
  }
  expect_failures = [var.cache_subnet_ids]
}

run "reject_single_subnet" {
  command = plan
  variables {
    subnet_ids = ["subnet-0000000000000000e"]
  }
  expect_failures = [var.subnet_ids]
}
