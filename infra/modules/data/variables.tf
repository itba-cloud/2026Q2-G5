variable "name" {
  description = "Prefix for the database identifier and its subnet group."
  type        = string
}

variable "subnet_ids" {
  description = "Database subnets, in at least two Availability Zones (RDS requires it even without Multi-AZ)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "RDS needs a subnet group with at least two subnets."
  }
}

variable "security_group_ids" {
  type = list(string)
}

variable "db_name" {
  type    = string
  default = "cloudgame"
}

variable "username" {
  type = string
}

variable "password" {
  description = "Master password. Ignored when manage_master_user_password is true."
  type        = string
  sensitive   = true
  default     = null
}

variable "manage_master_user_password" {
  description = "Let RDS generate the master password and keep it in Secrets Manager."
  type        = bool
  default     = false
}

variable "engine_version" {
  # Fijada a proposito: sin esto RDS toma la ultima mayor disponible, y el
  # parameter group default de cada mayor puede cambiar el comportamiento
  # (PostgreSQL 18 llego con rds.force_ssl=1 activado).
  type    = string
  default = "18.3"
}

variable "instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "allocated_storage" {
  type    = number
  default = 20
}

variable "multi_az" {
  description = "Keep a synchronous standby in another subnet's AZ; RDS fails over to it automatically."
  type        = bool
  default     = false
}

variable "cache_subnet_ids" {
  description = "Cache subnets, one per Availability Zone: the primary and the replica land in different ones."
  type        = list(string)

  validation {
    condition     = length(var.cache_subnet_ids) >= 2
    error_message = "Multi-AZ Redis needs subnets in at least two Availability Zones."
  }
}

variable "cache_security_group_ids" {
  type = list(string)
}

variable "cache_engine_version" {
  type    = string
  default = "7.1"
}

variable "cache_node_type" {
  type    = string
  default = "cache.t3.micro"
}
