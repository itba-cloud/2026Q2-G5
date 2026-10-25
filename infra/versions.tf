terraform {
  # Same tested version as .terraform-version, local checks and future CI.
  required_version = "= 1.16.1"

  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Environment = "lab"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
