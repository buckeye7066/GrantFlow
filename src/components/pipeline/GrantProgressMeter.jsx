import React from 'react';
import './GrantProgressMeter.css';

/**
 * GrantProgressMeter Component
 * Displays a 0-100% progress meter for grant processing through the pipeline
 * 
 * @component
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} stage - Current pipeline stage (optional)
 * @example
 * <GrantProgressMeter progress={50} stage="Drafting" />
 */
const GrantProgressMeter = ({ progress = 50, stage = 'Processing' }) => {
    // Ensure progress is between 0 and 100
    const normalizedProgress = Math.max(0, Math.min(100, progress));

    // Determine color based on progress level
    const getColorClass = () => {
          if (normalizedProgress < 40) return 'progress-low';
          if (normalizedProgress < 70) return 'progress-medium';
          return 'progress-high';
    };

    return (
          <div className="grant-progress-meter">
                <div className="progress-bar-container">
                        <div className="progress-bar">
                                  <div
                                                className={`progress-fill ${getColorClass()}`}
                                                style={{ width: `${normalizedProgress}%` }}
                                                aria-valuenow={normalizedProgress}
                                                aria-valuemin="0"
                                                aria-valuemax="100"
                                                role="progressbar"
                                              />
                        </div>div>
                        <div className="progress-percentage">
                          {normalizedProgress}%
                        </div>div>
                </div>div>
                <div className="progress-label">
                  {stage} • Processing Progress
                </div>div>
          </div>div>
        );
};

export default GrantProgressMeter;</div>
