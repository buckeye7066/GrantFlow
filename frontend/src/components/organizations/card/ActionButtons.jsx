import React, { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MoreVertical, Pencil, Trash2, DollarSign, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { OWNER_EMAIL } from "@/Layout";

/**
 * ActionButtons - Simple dropdown menu for organization card actions
 * 
 * @param {Object} organization - The organization data
 * @param {Function} onEdit - Edit handler
 * @param {Function} onDelete - Delete handler
 * @param {Function} onInvoice - Invoice handler
 * @param {Function} onAutomatedSearch - Automated search config handler
 */
export default function ActionButtons({ 
  organization, 
  onEdit, 
  onDelete, 
  onInvoice,
  onAutomatedSearch 
}) {
  // Check if current user is owner
  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });
  const isOwner = user?.email === OWNER_EMAIL;
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleEdit = (e) => {
    e.stopPropagation();
    setIsOpen(false);
    onEdit?.(organization);
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    setIsOpen(false);
    onDelete?.(organization);
  };

  const handleInvoice = (e) => {
    e.stopPropagation();
    setIsOpen(false);
    onInvoice?.(organization);
  };

  const handleAutomatedSearch = (e) => {
    e.stopPropagation();
    setIsOpen(false);
    onAutomatedSearch?.(organization);
  };

  return (
    <div className="relative" ref={menuRef}>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="More actions"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
      >
        <MoreVertical className="h-4 w-4" />
      </Button>
      
      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 rounded-md border bg-white shadow-lg z-50">
          <div className="py-1">
            <button
              onClick={handleEdit}
              className="flex w-full items-center px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              <Pencil className="mr-2 h-4 w-4" />
              Edit Profile
            </button>
            
            {onAutomatedSearch && (
              <button
                onClick={handleAutomatedSearch}
                className="flex w-full items-center px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                <Search className="mr-2 h-4 w-4" />
                Automated Search
              </button>
            )}
            
            {onInvoice && (
              <button
                onClick={handleInvoice}
                className="flex w-full items-center px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                <DollarSign className="mr-2 h-4 w-4" />
                Create Invoice
              </button>
            )}
            
            {isOwner && (
              <>
                <div className="my-1 h-px bg-slate-200" />
                
                <button
                  onClick={handleDelete}
                  className="flex w-full items-center px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Profile
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}