# Update Guide

Follow these steps to update to the latest version while preserving your data:

## Step 1: Backup Your Data

Before updating, create a backup of your important folders:
- `secure/` - Contains your wallet keys and credentials
- `storage/` - Contains mining history and logs

Copy these folders to a safe location outside the application directory.

## Step 2: Download Latest Version

Download the latest release from the repository or distribution source.

## Step 3: Restore Your Data

Copy your backed-up folders into the new version's directory:
1. Navigate to the newly downloaded application folder
2. Copy your `secure/` folder into this directory
3. Copy your `storage/` folder into this directory

## Step 4: Run Setup

Execute the setup script to complete the installation:
```bash
setup.cmd
```

The setup script will:
- Install required dependencies
- Build the hash engine
- Configure the application

Your wallet, mining history, and configuration will be preserved from the backup.