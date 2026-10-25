#!/usr/bin/env bash
# Los cuatro buckets se crean fuera de Terraform porque el SCP del Learner Lab
# deniega s3:GetBucketObjectLockConfiguration, y el recurso aws_s3_bucket lee
# esa configuracion siempre despues de crear. El resto (versioning, cifrado,
# website, policy y objetos) lo sigue manejando Terraform.
# Idempotente: se puede correr las veces que haga falta.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PROJECT="${PROJECT_NAME:-elastic-worlds}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

for role in snapshots client artifacts; do
  bucket="${PROJECT}-${role}-${ACCOUNT_ID}"

  if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    echo "ya existe: $bucket"
  else
    aws s3api create-bucket --bucket "$bucket" --region "$REGION" >/dev/null
    echo "creado:    $bucket"
  fi

  aws s3api put-bucket-tagging --bucket "$bucket" --tagging \
    "TagSet=[{Key=Name,Value=${PROJECT}-${role}},{Key=Project,Value=${PROJECT}},{Key=ManagedBy,Value=bootstrap-buckets.sh},{Key=Environment,Value=lab}]"
done
