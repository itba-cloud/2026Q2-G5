module "postgres" {
  source  = "terraform-aws-modules/rds/aws"
  version = "6.13.1"

  identifier                  = "${var.name}-db"
  engine                      = "postgres"
  engine_version              = var.engine_version
  instance_class              = var.instance_class
  allocated_storage           = var.allocated_storage
  storage_type                = "gp2"
  db_name                     = var.db_name
  username                    = var.username
  password                    = var.manage_master_user_password ? null : var.password
  manage_master_user_password = var.manage_master_user_password
  port                        = 5432
  vpc_security_group_ids      = var.security_group_ids
  publicly_accessible         = false
  multi_az                    = var.multi_az
  # Sin esto RDS deja los cambios para la ventana de mantenimiento semanal.
  apply_immediately               = true
  skip_final_snapshot             = true
  deletion_protection             = false
  storage_encrypted               = false
  create_db_subnet_group          = true
  db_subnet_group_name            = "${var.name}-db-subnets"
  db_subnet_group_use_name_prefix = false
  subnet_ids                      = var.subnet_ids
  db_subnet_group_description     = "Managed by Terraform"

  # Grupos default del motor, como sin el modulo.
  create_db_parameter_group = false
  create_db_option_group    = false

  # Fijados aunque coincidan con el default: el Learner Lab no permite crear
  # roles IAM, y Enhanced Monitoring crearia uno.
  create_monitoring_role = false
  monitoring_interval    = 0

  tags = { Name = "${var.name}-db" }
}

# Redis para el Pub/Sub entre mundos: primario y replica en dos AZ, con failover
# automatico. Sin AUTH: solo llegan los clientes que admiten el SG y la NACL de
# las subredes de cache (ver plan-elasticache.md), y el trafico va cifrado.
module "redis" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "1.11.2"

  replication_group_id = "${var.name}-redis"
  description          = "Cross-world Pub/Sub for ${var.name}"

  engine         = "redis"
  engine_version = var.cache_engine_version
  node_type      = var.cache_node_type
  port           = 6379

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  at_rest_encryption_enabled = true

  # El canal no guarda estado: sin snapshots. Los cambios se aplican en el
  # momento, sin esperar a la ventana de mantenimiento.
  snapshot_retention_limit = 0
  apply_immediately        = true

  create_subnet_group      = true
  subnet_group_name        = "${var.name}-redis"
  subnet_group_description = "Cache subnets for ${var.name}"
  subnet_ids               = var.cache_subnet_ids

  # El SG vive en el modulo raiz; parameter group default del motor; sin slow log.
  create_security_group      = false
  security_group_ids         = var.cache_security_group_ids
  create_parameter_group     = false
  log_delivery_configuration = {}

  tags = { Name = "${var.name}-redis" }
}
