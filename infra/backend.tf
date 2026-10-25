terraform {
  # Values are supplied to `terraform init` by the deployment workflow. Keeping
  # credentials and account-specific bucket names out of the source tree makes
  # local mock initialization independent of AWS.
  backend "s3" {}
}
