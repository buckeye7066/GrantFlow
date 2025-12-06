import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ImagePlus, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * Reusable profile image upload component
 */
export default function ProfileImageUpload({ 
  imageUrl, 
  onImageChange,
  size = 'w-24 h-24' 
}) {
  const [isUploading, setIsUploading] = useState(false);
  const { toast } = useToast();

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      onImageChange(file_url);
      
      toast({
        title: "Image Uploaded",
        description: "Profile image updated successfully.",
      });
    } catch (error) {
      console.error("Image upload failed:", error);
      toast({
        title: "Upload Failed",
        description: "There was an error uploading your image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="flex items-center gap-6">
      <div className="relative">
        <Label htmlFor="profile-image-upload" className="cursor-pointer">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt="Profile"
              className={`${size} rounded-full object-cover border-2 hover:opacity-80 transition-opacity`}
            />
          ) : (
            <div className={`${size} rounded-full bg-slate-100 flex items-center justify-center border-2 border-dashed hover:bg-slate-200 transition-colors`}>
              <ImagePlus className="w-8 h-8 text-slate-400" />
            </div>
          )}
        </Label>
        <Input
          id="profile-image-upload"
          type="file"
          className="hidden"
          onChange={handleUpload}
          accept="image/*"
          disabled={isUploading}
          aria-label="Upload profile image"
        />
        {isUploading && (
          <div className="absolute inset-0 bg-white bg-opacity-70 flex items-center justify-center rounded-full">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          </div>
        )}
      </div>
      <div className="flex-1">
        <Label className="text-base font-semibold mb-2 block">Profile Picture</Label>
        <p className="text-sm text-slate-500">
          Click the image to upload a new one. Recommended size: 400x400px.
        </p>
      </div>
    </div>
  );
}