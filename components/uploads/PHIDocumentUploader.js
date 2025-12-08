import React, { Component } from 'react';

/**
 * PHIDocumentUploader - Component for uploading PHI (Protected Health Information) documents
 * 
 * This component handles secure document uploads and ensures proper callback handling
 * to prevent runtime errors when parent components don't provide required callbacks.
 */
class PHIDocumentUploader extends Component {
  constructor(props) {
    super(props);
    this.state = {
      uploading: false,
      error: null,
      uploadedFiles: []
    };
  }

  /**
   * Safely calls the onUpdate callback if provided
   * Guards against missing callback to prevent "Update Handler Missing" errors
   * 
   * @param {Object} updateData - Data to pass to the onUpdate callback
   */
  safeOnUpdate = (updateData) => {
    const { onUpdate } = this.props;
    
    // Guard: only call onUpdate if it's a function
    if (typeof onUpdate === 'function') {
      onUpdate(updateData);
    } else {
      // Log warning to help developers identify missing callback during development
      console.warn('[PHIDocumentUploader] onUpdate callback missing - skipping profile update');
    }
  };

  handleFileUpload = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    this.setState({ uploading: true, error: null });

    try {
      // TODO: Replace with actual upload logic (e.g., API call to upload endpoint)
      const uploadedFileData = {
        fileName: files[0].name,
        fileSize: files[0].size,
        uploadDate: new Date().toISOString()
      };

      this.setState(prevState => {
        const updatedFiles = [...prevState.uploadedFiles, uploadedFileData];
        
        // Safely call onUpdate with uploaded file data after state update
        this.safeOnUpdate({
          action: 'file_uploaded',
          file: uploadedFileData,
          allFiles: updatedFiles
        });

        return {
          uploadedFiles: updatedFiles,
          uploading: false
        };
      });

    } catch (error) {
      console.error('[PHIDocumentUploader] Upload failed:', error);
      this.setState({ 
        uploading: false, 
        error: 'Upload failed. Please try again.' 
      });

      // Safely notify parent of error
      this.safeOnUpdate({
        action: 'upload_error',
        error: error.message
      });
    }
  };

  handleFileRemove = (fileName) => {
    this.setState(prevState => {
      const updatedFiles = prevState.uploadedFiles.filter(
        file => file.fileName !== fileName
      );
      
      return { uploadedFiles: updatedFiles };
    }, () => {
      // Safely call onUpdate after state update is complete
      this.safeOnUpdate({
        action: 'file_removed',
        fileName: fileName,
        allFiles: this.state.uploadedFiles
      });
    });
  };

  render() {
    const { uploading, error, uploadedFiles } = this.state;

    return (
      <div className="phi-document-uploader">
        <div className="upload-section">
          <input
            type="file"
            onChange={this.handleFileUpload}
            disabled={uploading}
            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
          />
          {uploading && <span className="uploading-indicator">Uploading...</span>}
          {error && <div className="error-message">{error}</div>}
        </div>

        {uploadedFiles.length > 0 && (
          <div className="uploaded-files">
            <h3>Uploaded Files:</h3>
            <ul>
              {uploadedFiles.map((file, index) => (
                <li key={index}>
                  <span>{file.fileName}</span>
                  <button
                    onClick={() => this.handleFileRemove(file.fileName)}
                    className="remove-button"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
}

export default PHIDocumentUploader;
