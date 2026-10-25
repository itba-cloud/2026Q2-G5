variable "name" {
  description = "Prefix for every resource name in the network."
  type        = string
}

variable "region" {
  description = "AWS region, used to build the VPC endpoint service names."
  type        = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "azs" {
  description = "Availability Zones, in order. Subnet i of every tier lands in azs[i]."
  type        = list(string)
}

variable "subnet_cidrs" {
  description = "CIDR blocks per tier. Public subnets reach the Internet Gateway; the rest have no route to the Internet."
  type = object({
    public      = list(string)
    private     = list(string)
    database    = list(string)
    elasticache = list(string)
  })

  validation {
    condition = alltrue([
      for tier in ["public", "private", "database", "elasticache"] :
      length(var.subnet_cidrs[tier]) <= length(var.azs)
    ])
    error_message = "Each tier needs at most one subnet per Availability Zone."
  }
}

variable "gateway_endpoints" {
  description = "Services reached through gateway endpoints from the public and private route tables."
  type        = list(string)
  default     = ["s3", "dynamodb"]

  validation {
    condition     = contains(var.gateway_endpoints, "s3")
    error_message = "The S3 gateway endpoint is required: its prefix list is an output of this module."
  }
}

variable "interface_endpoints" {
  description = "Interface endpoints grouped by who consumes them, as group => services. Each group gets its own security group, with no ingress: the caller adds rules for its consumers."
  type        = map(list(string))
  default     = {}
}

variable "database_port" {
  type    = number
  default = 5432
}

variable "database_client_tiers" {
  description = "Tiers whose subnets may open connections to the database subnets."
  type        = list(string)
  default     = ["private"]

  validation {
    condition     = alltrue([for tier in var.database_client_tiers : contains(["public", "private"], tier)])
    error_message = "Client tiers are public or private."
  }
}

variable "elasticache_port" {
  type    = number
  default = 6379
}

variable "elasticache_client_tiers" {
  description = "Tiers whose subnets may open connections to the cache subnets."
  type        = list(string)
  default     = ["private", "public"]

  validation {
    condition     = alltrue([for tier in var.elasticache_client_tiers : contains(["public", "private"], tier)])
    error_message = "Client tiers are public or private."
  }
}

variable "elasticache_replication" {
  description = "Allow traffic between the cache subnets themselves, needed by a primary and its replicas in different subnets."
  type        = bool
  default     = true
}
