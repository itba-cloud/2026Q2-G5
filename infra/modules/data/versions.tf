terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # rds 6.13.1 exige >= 5.92 y elasticache 1.11.2 >= 5.93; sus lineas siguientes exigen el provider 6.
      version = ">= 5.93, < 6.0"
    }
  }
}
