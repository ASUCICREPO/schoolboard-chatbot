#!/bin/bash
set -e

echo "Deploying frontend to Amplify..."

AWS_REGION=${AWS_REGION:-}
if [ -z "$AWS_REGION" ]; then
  printf "AWS Region (e.g. us-west-2, us-east-1): "
  read AWS_REGION
  if [ -z "$AWS_REGION" ]; then
    echo "[ERROR] Region is required."
    exit 1
  fi
fi

# Find the Amplify app
AMPLIFY_APP_ID=$(aws amplify list-apps --region "$AWS_REGION" --query "apps[?name=='schoolbot-beam'].appId" --output text) || {
  echo "ERROR: Failed to list Amplify apps. Check AWS credentials."
  echo "  Run: export AWS_PROFILE=your-profile"
  exit 1
}

if [ -z "$AMPLIFY_APP_ID" ] || [ "$AMPLIFY_APP_ID" = "None" ]; then
  echo "ERROR: Amplify app 'schoolbot-beam' not found. Run deploy.sh first."
  exit 1
fi

cd frontend

# Build
echo "Building Next.js..."
npm run build

# Zip the contents of out/ (files at zip root, not inside an out/ folder)
echo "Packaging build..."
rm -f build.zip
if command -v zip >/dev/null 2>&1; then
  cd out && zip -r ../build.zip . -q && cd ..
else
  # Windows: write a temp PowerShell script to avoid heredoc issues
  OUTDIR=$(cd out && pwd -W 2>/dev/null || pwd)
  ZIPPATH=$(cd . && pwd -W 2>/dev/null || pwd)/build.zip
  cat > _zip_tmp.ps1 << ENDPS
Add-Type -Assembly System.IO.Compression.FileSystem
\$outDir = "$OUTDIR"
\$zipPath = "$ZIPPATH"
if (Test-Path \$zipPath) { Remove-Item \$zipPath }
\$zip = [System.IO.Compression.ZipFile]::Open(\$zipPath, "Create")
Get-ChildItem -Path \$outDir -Recurse -File | ForEach-Object {
  \$rel = \$_.FullName.Substring(\$outDir.Length + 1).Replace("\", "/")
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(\$zip, \$_.FullName, \$rel) | Out-Null
}
\$zip.Dispose()
ENDPS
  powershell -ExecutionPolicy Bypass -File _zip_tmp.ps1
  rm -f _zip_tmp.ps1
fi
echo "[OK] Build packaged"

# Deploy to Amplify
echo "Uploading to Amplify..."
DEPLOY_RESULT=$(aws amplify create-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name main \
  --region "$AWS_REGION" \
  --output json)

DEPLOY_URL=$(echo "$DEPLOY_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).zipUploadUrl))")
JOB_ID=$(echo "$DEPLOY_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).jobId))")

# Upload
if command -v curl >/dev/null 2>&1; then
  curl -s -T build.zip "$DEPLOY_URL"
else
  powershell -Command "Invoke-RestMethod -Method Put -Uri '$DEPLOY_URL' -InFile 'build.zip' -ContentType 'application/zip'"
fi

# Start deployment
aws amplify start-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name main \
  --job-id "$JOB_ID" \
  --region "$AWS_REGION" >/dev/null

rm -f build.zip

echo "[OK] Deployed to https://main.${AMPLIFY_APP_ID}.amplifyapp.com"
