#!/usr/bin/env python3
"""Create the persistent, private S3 bucket used by Terraform's remote state."""
import argparse
import json
import os
import subprocess

OWNER_TAG = "elastic-worlds-task-09"


def aws(region, *args):
    return subprocess.run(
        ["aws", *args, "--region", region, "--no-cli-pager", "--output", "json"],
        check=True, text=True, capture_output=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default=os.getenv("AWS_REGION", "us-east-1"))
    parser.add_argument("--bucket", help="Defaults to elastic-worlds-tfstate-<AWS account id>")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--execute", action="store_true", help="Create or verify the persistent backend")
    mode.add_argument("--check-only", action="store_true", help="Require an existing owned backend without changing it")
    args = parser.parse_args()

    account = aws(args.region, "sts", "get-caller-identity")
    account_id = json.loads(account.stdout)["Account"]
    bucket = args.bucket or f"elastic-worlds-tfstate-{account_id}"
    if len(bucket) > 63 or not bucket.startswith("elastic-worlds-tfstate-"):
        parser.error("Bucket must use the elastic-worlds-tfstate- prefix and be at most 63 characters")

    exists = subprocess.run(
        ["aws", "s3api", "head-bucket", "--bucket", bucket, "--region", args.region,
         "--no-cli-pager"], capture_output=True, text=True,
    ).returncode == 0
    if exists:
        tags = json.loads(aws(args.region, "s3api", "get-bucket-tagging", "--bucket", bucket).stdout)
        if not any(t["Key"] == "ManagedBy" and t["Value"] == OWNER_TAG for t in tags["TagSet"]):
            raise SystemExit("Bucket exists without the expected ownership tag; refusing to modify it.")
    else:
        if args.check_only:
            raise SystemExit("State bucket is unavailable. Run Deploy first; Plan and Destroy never create a backend.")
        create = ["s3api", "create-bucket", "--bucket", bucket]
        if args.region != "us-east-1":
            create += ["--create-bucket-configuration", f"LocationConstraint={args.region}"]
        aws(args.region, *create)

    if args.check_only:
        print(json.dumps({"bucket": bucket, "region": args.region, "created": False}))
        return

    aws(args.region, "s3api", "put-public-access-block", "--bucket", bucket,
        "--public-access-block-configuration",
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true")
    aws(args.region, "s3api", "put-bucket-encryption", "--bucket", bucket,
        "--server-side-encryption-configuration",
        json.dumps({"Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}))
    aws(args.region, "s3api", "put-bucket-versioning", "--bucket", bucket,
        "--versioning-configuration", "Status=Enabled")
    aws(args.region, "s3api", "put-bucket-tagging", "--bucket", bucket,
        "--tagging", json.dumps({"TagSet": [
            {"Key": "ManagedBy", "Value": OWNER_TAG},
            {"Key": "OwnerAccount", "Value": account_id},
            {"Key": "Purpose", "Value": "Terraform remote state and lock files"},
        ]}))
    print(json.dumps({"bucket": bucket, "region": args.region, "created": not exists,
                      "versioning": "Enabled", "encryption": "AES256", "public_access": "Blocked"}))


if __name__ == "__main__":
    main()
