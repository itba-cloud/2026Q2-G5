terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # terraform-aws-modules/vpc 5.21.0 exige >= 5.79; su linea 6.x exige el provider 6.
      version = ">= 5.79, < 6.0"
    }
  }
}
