#!/usr/bin/env bash
# ensure-console-iam.sh — idempotent provisioner for the IAM identity the
# operator console uses to call EC2 SG APIs (Describe/Authorize/Revoke).
#
# Creates (if missing) a per-instance IAM user `nvidia-vss-console-<instance>`, an
# inline policy scoped to the instance's Security Group, and one access key
# pair. The key pair is cached in
#   scripts/instances/<instance>/.console-iam.env
# (gitignored by the catch-all *.env rule) because AWS only returns the
# secret at creation time. Re-running this script reuses the cached pair
# when it still lists as Active on the user.
#
# Output (stdout, eval-able):
#   CONSOLE_IAM_USER=...
#   CONSOLE_IAM_ACCESS_KEY_ID=...
#   CONSOLE_IAM_SECRET_ACCESS_KEY=...
#
# Requires: aws CLI + AWS_PROFILE with iam:CreateUser, iam:PutUserPolicy,
# iam:CreateAccessKey, iam:ListAccessKeys on users/nvidia-vss-console-*. If the
# caller lacks those (e.g. Engineering-EC2User SSO role), fails with a
# clear error and a policy snippet for the admin to attach.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-paths.sh
source "$SCRIPT_DIR/lib-paths.sh" "$@"

: "${AWS_PROFILE:=scality-ec2}"
: "${AWS_REGION:=us-west-2}"
export AWS_PROFILE AWS_REGION

[[ -f "$VSS_STATE_FILE" ]] || {
  echo "ERROR: $VSS_STATE_FILE missing — run launch-stack.sh first" >&2
  exit 1
}
# shellcheck source=/dev/null
source "$VSS_STATE_FILE"
: "${SG_ID:?SG_ID missing from $VSS_STATE_FILE}"
: "${INSTANCE_ID:?INSTANCE_ID missing from $VSS_STATE_FILE}"

# aws returns the account id via sts; cache it so subsequent calls skip.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || {
  echo "ERROR: aws sts get-caller-identity failed — check AWS_PROFILE=$AWS_PROFILE and SSO session" >&2
  exit 1
}

USER_NAME="nvidia-vss-console-${VSS_INSTANCE}"
POLICY_NAME="nvidia-vss-console-sg-crud"
CACHE_FILE="$VSS_INSTANCE_DIR/.console-iam.env"

SG_ARN="arn:aws:ec2:${AWS_REGION}:${ACCOUNT_ID}:security-group/${SG_ID}"

# Minimum-privilege policy — scoped to the instance's single SG for the
# write verbs; Describe unavoidably needs "*" per AWS IAM spec.
read -r -d '' POLICY_DOC <<JSON || true
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DescribeAllSGs",
      "Effect": "Allow",
      "Action": "ec2:DescribeSecurityGroups",
      "Resource": "*"
    },
    {
      "Sid": "MutateInstanceSGOnly",
      "Effect": "Allow",
      "Action": [
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress"
      ],
      "Resource": "${SG_ARN}"
    }
  ]
}
JSON

echo "==> ensure-console-iam: instance=$VSS_INSTANCE user=$USER_NAME sg=$SG_ID" >&2

# 1) Create user (idempotent)
if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "    user $USER_NAME already exists" >&2
else
  aws iam create-user --user-name "$USER_NAME" >/dev/null || {
    cat >&2 <<EOF
ERROR: iam:CreateUser denied. Your caller principal lacks IAM write access.

Either: attach the following policy to your SSO role, OR have an admin run
this script once on your behalf.

    {
      "Effect": "Allow",
      "Action": [
        "iam:CreateUser", "iam:GetUser", "iam:PutUserPolicy",
        "iam:CreateAccessKey", "iam:ListAccessKeys", "iam:DeleteAccessKey"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:user/nvidia-vss-console-*"
    }
EOF
    exit 1
  }
  echo "    created user $USER_NAME" >&2
fi

# 2) Attach inline policy (put = overwrite, always safe to re-run)
aws iam put-user-policy \
  --user-name "$USER_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$POLICY_DOC" >/dev/null
echo "    policy $POLICY_NAME attached (sg=$SG_ID)" >&2

# 3) Reuse cached key pair if still Active, otherwise rotate
RUNTIME_ACCESS_KEY_ID=""
RUNTIME_SECRET_ACCESS_KEY=""
if [[ -f "$CACHE_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$CACHE_FILE"
  if [[ -n "${CONSOLE_IAM_ACCESS_KEY_ID:-}" ]]; then
    STATUS="$(aws iam list-access-keys --user-name "$USER_NAME" \
      --query "AccessKeyMetadata[?AccessKeyId==\`$CONSOLE_IAM_ACCESS_KEY_ID\`].Status" \
      --output text 2>/dev/null || true)"
    if [[ "$STATUS" == "Active" ]]; then
      RUNTIME_ACCESS_KEY_ID="$CONSOLE_IAM_ACCESS_KEY_ID"
      RUNTIME_SECRET_ACCESS_KEY="$CONSOLE_IAM_SECRET_ACCESS_KEY"
      echo "    reusing cached access key ${RUNTIME_ACCESS_KEY_ID:0:8}… (Active)" >&2
    else
      echo "    cached access key is $STATUS — rotating" >&2
    fi
  fi
fi

if [[ -z "$RUNTIME_ACCESS_KEY_ID" ]]; then
  # AWS limits 2 keys/user. Prune any existing keys that we can't reuse
  # (we don't have their secrets) so create-access-key doesn't hit the cap.
  while read -r stale; do
    [[ -n "$stale" ]] || continue
    aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$stale" >/dev/null
    echo "    deleted stale access key ${stale:0:8}…" >&2
  done < <(aws iam list-access-keys --user-name "$USER_NAME" \
    --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null | tr '\t' '\n')

  CREATE_JSON="$(aws iam create-access-key --user-name "$USER_NAME" --output json)"
  RUNTIME_ACCESS_KEY_ID="$(echo "$CREATE_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["AccessKey"]["AccessKeyId"])')"
  RUNTIME_SECRET_ACCESS_KEY="$(echo "$CREATE_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["AccessKey"]["SecretAccessKey"])')"

  mkdir -p "$VSS_INSTANCE_DIR"
  umask 077
  cat > "$CACHE_FILE" <<EOF
# Auto-generated by ensure-console-iam.sh — do not commit.
CONSOLE_IAM_USER=$USER_NAME
CONSOLE_IAM_ACCESS_KEY_ID=$RUNTIME_ACCESS_KEY_ID
CONSOLE_IAM_SECRET_ACCESS_KEY=$RUNTIME_SECRET_ACCESS_KEY
EOF
  echo "    created access key ${RUNTIME_ACCESS_KEY_ID:0:8}… (cached to $CACHE_FILE)" >&2
fi

# 4) Emit eval-able output on stdout
cat <<EOF
CONSOLE_IAM_USER=$USER_NAME
CONSOLE_IAM_ACCESS_KEY_ID=$RUNTIME_ACCESS_KEY_ID
CONSOLE_IAM_SECRET_ACCESS_KEY=$RUNTIME_SECRET_ACCESS_KEY
EOF
