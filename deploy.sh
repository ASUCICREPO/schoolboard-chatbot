#!/bin/bash
set -e

echo "============================================"
echo "  The Beam — School Board AI Deployment"
echo "============================================"
echo ""

# ── Check prerequisites ──────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || { echo "❌ Node.js is required. Install from https://nodejs.org"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "❌ AWS CLI is required. Install from https://aws.amazon.com/cli/"; exit 1; }
command -v cdk >/dev/null 2>&1 || { echo "⚠  AWS CDK not found. Installing globally..."; npm install -g aws-cdk; }

echo "✓ Prerequisites checked"
echo ""

# ── Verify AWS credentials ───────────────────────────────────────────────────

echo "Verifying AWS credentials..."
AWS_ACCOUNT=$(aws sts get-caller-identity --query "Account" --output text 2>/dev/null) || {
  echo "❌ AWS credentials not configured. Run:"
  echo "   aws sso login --profile your-profile"
  echo "   export AWS_PROFILE=your-profile"
  exit 1
}
AWS_REGION=${AWS_REGION:-us-west-2}
echo "✓ AWS Account: $AWS_ACCOUNT"
echo "✓ AWS Region:  $AWS_REGION"
echo ""

# ── Check for GitHub token (needed for Amplify) ──────────────────────────────

echo "Checking GitHub token for Amplify..."
aws secretsmanager describe-secret --secret-id github-token --region "$AWS_REGION" >/dev/null 2>&1 || {
  echo "⚠  No 'github-token' secret found in Secrets Manager."
  echo "   Amplify needs a GitHub Personal Access Token to connect to your repo."
  echo "   Create one at: https://github.com/settings/tokens (scope: repo)"
  read -sp "Enter your GitHub token (or press Enter to skip Amplify): " GH_TOKEN
  echo ""
  if [ -n "$GH_TOKEN" ]; then
    aws secretsmanager create-secret \
      --name "github-token" \
      --description "GitHub Personal Access Token for Amplify" \
      --secret-string "$GH_TOKEN" \
      --region "$AWS_REGION"
    echo "✓ GitHub token stored in Secrets Manager"
  else
    echo "⚠  Skipping — Amplify deployment will fail without a GitHub token"
  fi
}
echo ""

# ── Check for YouTube API key ────────────────────────────────────────────────

if [ ! -f cdk/.env ]; then
  echo "⚠  No cdk/.env file found."
  read -p "Enter your YouTube Data API v3 key (or press Enter to skip): " YT_KEY
  if [ -n "$YT_KEY" ]; then
    echo "YOUTUBE_API_KEY=$YT_KEY" > cdk/.env
    echo "✓ Saved YouTube API key to cdk/.env"
  else
    echo "YOUTUBE_API_KEY=" > cdk/.env
    echo "⚠  YouTube monitoring will not work without an API key"
  fi
else
  echo "✓ cdk/.env exists"
fi
echo ""

# ── Install CDK dependencies ─────────────────────────────────────────────────

echo "Installing CDK dependencies..."
cd cdk
npm install --silent
echo "✓ CDK dependencies installed"
echo ""

# ── Bootstrap CDK (if needed) ────────────────────────────────────────────────

echo "Checking CDK bootstrap..."
cdk bootstrap aws://$AWS_ACCOUNT/$AWS_REGION 2>/dev/null || true
echo "✓ CDK bootstrapped"
echo ""

# ── Deploy the stack ─────────────────────────────────────────────────────────

echo "Deploying SchoolbotStack..."
echo ""
cdk deploy --require-approval never --outputs-file ../cdk-outputs.json

echo ""
echo "✓ Stack deployed successfully"
echo ""

# ── Extract outputs ──────────────────────────────────────────────────────────

API_URL=$(node -e "const o=require('../cdk-outputs.json');console.log(o.SchoolbotStack.ApiUrl)")
USER_POOL_ID=$(node -e "const o=require('../cdk-outputs.json');console.log(o.SchoolbotStack.UserPoolId)")
CLIENT_ID=$(node -e "const o=require('../cdk-outputs.json');console.log(o.SchoolbotStack.UserPoolClientId)")
AMPLIFY_URL=$(node -e "const o=require('../cdk-outputs.json');console.log(o.SchoolbotStack.AmplifyAppUrl || 'not deployed')")

echo "Stack Outputs:"
echo "  API URL:        $API_URL"
echo "  User Pool ID:   $USER_POOL_ID"
echo "  Client ID:      $CLIENT_ID"
echo "  Amplify URL:    $AMPLIFY_URL"
echo ""

# ── Create admin user ────────────────────────────────────────────────────────

echo "Setting up admin user..."
read -p "Create an admin user? (y/n): " CREATE_ADMIN
if [ "$CREATE_ADMIN" = "y" ] || [ "$CREATE_ADMIN" = "Y" ]; then
  read -p "  Admin username: " ADMIN_USER
  read -sp "  Admin password: " ADMIN_PASS
  echo ""

  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_USER" \
    --temporary-password "TempPass123!" \
    --message-action SUPPRESS \
    --region "$AWS_REGION" 2>/dev/null || true

  aws cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_USER" \
    --password "$ADMIN_PASS" \
    --permanent \
    --region "$AWS_REGION"

  echo "✓ Admin user '$ADMIN_USER' created"
else
  echo "⏭  Skipping admin user creation"
fi
echo ""

# ── Configure frontend ───────────────────────────────────────────────────────

echo "Configuring frontend..."
cd ../frontend
npm install --silent

cat > .env << EOF
NEXT_PUBLIC_API_URL=$API_URL
NEXT_PUBLIC_COGNITO_USER_POOL_ID=$USER_POOL_ID
NEXT_PUBLIC_COGNITO_CLIENT_ID=$CLIENT_ID
EOF

echo "✓ Frontend configured"
echo ""

# ── Done ─────────────────────────────────────────────────────────────────────

echo "============================================"
echo "  ✅ Deployment Complete!"
echo "============================================"
echo ""
echo "  API:       $API_URL"
echo "  Frontend:  $AMPLIFY_URL"
echo "  Admin:     ${AMPLIFY_URL}/admin"
echo ""
echo "  Next steps:"
echo "  1. Visit ${AMPLIFY_URL}/admin"
echo "  2. Log in and click 'Scan YouTube Channels'"
echo "  3. Upload transcripts for discovered videos"
echo "  4. Amplify auto-deploys on push to main"
echo ""
