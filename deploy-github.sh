#!/bin/bash
# Signal-Zero GitHub Deployment Script
# Automatically pushes to GitHub with authentication

echo "🚀 Signal-Zero GitHub Deployment Script"
echo "======================================="
echo ""

# Check if GitHub CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI not found. Installing..."
    # Installation varies by platform
    echo "Please install GitHub CLI from: https://cli.github.com"
    echo "Or use: choco install gh (Windows)"
    exit 1
fi

# Authenticate with GitHub
echo "🔐 Authenticating with GitHub..."
gh auth login

# Get current user
GITHUB_USER=$(gh api user -q '.login')
echo "✅ Authenticated as: $GITHUB_USER"
echo ""

# Create repository
echo "📦 Creating GitHub repository..."
REPO_NAME="signal-zero-deployment"

# Check if repo exists
if gh repo view "$GITHUB_USER/$REPO_NAME" 2>/dev/null; then
    echo "✅ Repository already exists: $GITHUB_USER/$REPO_NAME"
else
    echo "Creating new repository..."
    gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
    echo "✅ Repository created and pushed!"
fi

echo ""
echo "🌐 Repository URL: https://github.com/$GITHUB_USER/$REPO_NAME"
echo "✨ Deployment complete!"
