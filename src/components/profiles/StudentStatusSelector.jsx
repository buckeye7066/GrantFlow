import React, { useState, useEffect } from 'react';
import './StudentStatusSelector.css';

const StudentStatusSelector = ({ value = '', onChange, required = true, disabled = false }) => {
    const [selectedStatus, setSelectedStatus] = useState(value);

    useEffect(() => {
          setSelectedStatus(value);
    }, [value]);

    const statusOptions = [
      { id: 'currently_enrolled_full_time', label: 'Currently enrolled student (Full-time)', description: 'Actively attending school/university', category: 'current' },
      { id: 'currently_enrolled_part_time', label: 'Currently enrolled student (Part-time)', description: 'Attending school on part-time basis', category: 'current' },
      { id: 'prospective_student', label: 'Prospective student (accepted/applying)', description: 'Accepted to or applying to school', category: 'prospective' },
      { id: 'recently_graduated', label: 'Recently graduated (within 2 years)', description: 'Completed education recently', category: 'recent' },
      { id: 'not_student', label: 'NOT a student / Non-traditional learner', description: 'Not pursuing formal education', category: 'non-student' }
        ];

    const handleStatusChange = (statusId) => {
          setSelectedStatus(statusId);
          onChange(statusId);
    };

    const currentSelected = statusOptions.find(opt => opt.id === selectedStatus);

    return (
          <div className="student-status-selector">
                <div className="status-selector-header">
                        <label className="status-selector-label">
                                  Student Status {required && <span className="required-indicator">*</span>}
                        </label>
                        <p>Select your student status for accurate grant matching.</p>
                </div>
          
                <div className="status-options-container">
                  {statusOptions.map((option) => (
                      <div key={option.id} className="status-option">
                                  <input
                                                  type="radio"
                                                  id={option.id}
                                                  name="student-status"
                                                  value={option.id}
                                                  checked={selectedStatus === option.id}
                                                  onChange={() => handleStatusChange(option.id)}
                                                  disabled={disabled}
                                                  required={required}
                                                  className="status-radio"
                                                />
                                  <label htmlFor={option.id} className="status-option-label">
                                                <span className="option-title">{option.label}</span>
                                                <span className="option-description">{option.description}</span>
                                  </label>
                      </div>
                    ))}
                </div>
          
            {currentSelected && (
                    <div className="status-selection-summary">
                              <p className="summary-label">Selected: {currentSelected.label}</p>
                    </div>
                )}
          
            {selectedStatus === 'not_student' && (
                    <div className="student-status-warning">
                              <p>Non-student status may limit eligibility for education-focused grants.</p>
                    </div>
                )}
          </div>
        );
};

export default StudentStatusSelector;
