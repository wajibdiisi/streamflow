const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { paths, getUniqueFilename } = require('./storage');

function createDriveService(apiKey) {
  return google.drive({
    version: 'v3',
    auth: apiKey
  });
}

function extractFileId(driveUrl) {

  let match = driveUrl.match(/\/file\/d\/([^\/]+)/);
  if (match) return match[1];

  match = driveUrl.match(/\?id=([^&]+)/);
  if (match) return match[1];

  match = driveUrl.match(/\/d\/([^\/]+)/);
  if (match) return match[1];

  if (/^[a-zA-Z0-9_-]{25,}$/.test(driveUrl.trim())) {
    return driveUrl.trim();
  }

  throw new Error('Invalid Google Drive URL format');
}

function extractFolderId(driveUrl) {
  // Extract folder ID from Google Drive folder URLs
  let match = driveUrl.match(/\/folders\/([^\/\?]+)/);
  if (match) return match[1];

  match = driveUrl.match(/\?id=([^&]+)/);
  if (match) return match[1];

  if (/^[a-zA-Z0-9_-]{25,}$/.test(driveUrl.trim())) {
    return driveUrl.trim();
  }

  throw new Error('Invalid Google Drive folder URL format');
}

async function isFolder(apiKey, resourceId) {
  const drive = createDriveService(apiKey);

  try {
    const resource = await drive.files.get({
      fileId: resourceId,
      fields: 'mimeType'
    });

    return resource.data.mimeType === 'application/vnd.google-apps.folder';
  } catch (error) {
    return false;
  }
}

async function listFolderContents(apiKey, folderId) {
  const drive = createDriveService(apiKey);

  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,size)',
      pageSize: 1000
    });

    return response.data.files.filter(file =>
      file.mimeType.includes('video') || file.mimeType === 'application/vnd.google-apps.folder'
    );
  } catch (error) {
    console.error('Error listing folder contents:', error);
    throw error;
  }
}

async function downloadFile(apiKey, fileId, progressCallback = null, folderPath = 'Default') {
  const drive = createDriveService(apiKey);

  try {

    const fileMetadata = await drive.files.get({
      fileId: fileId,
      fields: 'name,mimeType,size'
    });

    if (!fileMetadata.data.mimeType.includes('video')) {
      throw new Error('The selected file is not a video');
    }

    const originalFilename = fileMetadata.data.name;
    const ext = path.extname(originalFilename) || '.mp4';
    const uniqueFilename = getUniqueFilename(originalFilename);
    const localFilePath = path.join(paths.videos, uniqueFilename);
    const dest = fs.createWriteStream(localFilePath);
    const response = await drive.files.get(
      {
        fileId: fileId,
        alt: 'media'
      },
      { responseType: 'stream' }
    );

    const fileSize = parseInt(fileMetadata.data.size, 10);
    let downloaded = 0;

    return new Promise((resolve, reject) => {
      response.data
        .on('data', chunk => {
          downloaded += chunk.length;
          if (progressCallback) {
            const progress = Math.round((downloaded / fileSize) * 100);
            progressCallback({
              id: fileId,
              filename: originalFilename,
              progress: progress
            });
          }
        })
        .on('end', () => {
          console.log(`Downloaded file ${originalFilename} from Google Drive`);
          resolve({
            filename: uniqueFilename,
            originalFilename: originalFilename,
            localFilePath: localFilePath,
            mimeType: fileMetadata.data.mimeType,
            fileSize: fileSize
          });
        })
        .on('error', err => {
          fs.unlinkSync(localFilePath);
          reject(err);
        })
        .pipe(dest);
    });
  } catch (error) {
    console.error('Error downloading file from Google Drive:', error);
    throw error;
  }
}

async function downloadFolder(apiKey, folderId, progressCallback = null, folderPath = null) {
  const drive = createDriveService(apiKey);

  try {
    // Get folder metadata
    const folderMetadata = await drive.files.get({
      fileId: folderId,
      fields: 'name,mimeType'
    });

    if (folderMetadata.data.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('The provided ID is not a folder');
    }

    const folderName = folderMetadata.data.name;
    // Use the provided folderPath or fallback to the Google Drive folder name
    const targetFolderPath = folderPath || folderName;

    console.log('downloadFolder: using folderPath =', targetFolderPath);

    const files = await listFolderContents(apiKey, folderId);
    const videoFiles = files.filter(file => file.mimeType.includes('video'));

    if (videoFiles.length === 0) {
      throw new Error('No video files found in the folder');
    }

    const results = [];
    let completedFiles = 0;

    for (const file of videoFiles) {
      try {
        const result = await downloadFile(apiKey, file.id, (progress) => {
          if (progressCallback) {
            const overallProgress = Math.round(((completedFiles + (progress.progress / 100)) / videoFiles.length) * 100);
            progressCallback({
              id: folderId,
              filename: folderName,
              currentFile: progress.filename,
              progress: overallProgress,
              completed: completedFiles,
              total: videoFiles.length
            });
          }
        }, targetFolderPath);

        // Ensure the result has the correct folderPath
        result.folderPath = targetFolderPath;

        results.push(result);
        completedFiles++;

        if (progressCallback) {
          const overallProgress = Math.round((completedFiles / videoFiles.length) * 100);
          progressCallback({
            id: folderId,
            filename: folderName,
            currentFile: 'Processing...',
            progress: overallProgress,
            completed: completedFiles,
            total: videoFiles.length,
            folderPath: targetFolderPath
          });
        }
      } catch (fileError) {
        console.error(`Error downloading file ${file.name}:`, fileError);
        // Continue with other files even if one fails
      }
    }

    return {
      folderName: folderName,
      files: results,
      totalFiles: videoFiles.length,
      successfulFiles: results.length
    };
  } catch (error) {
    console.error('Error downloading folder from Google Drive:', error);
    throw error;
  }
}

module.exports = {
  createDriveService,
  extractFileId,
  extractFolderId,
  isFolder,
  listFolderContents,
  downloadFile,
  downloadFolder
};