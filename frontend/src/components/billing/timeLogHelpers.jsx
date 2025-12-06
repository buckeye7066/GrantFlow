export const getDefaultHourlyRate = (timeLog, selectedProject, billingSettings) => {
  if (timeLog && timeLog.hourly_rate !== undefined) {
    return timeLog.hourly_rate;
  }
  
  if (selectedProject?.hourly_rate) {
    return selectedProject.hourly_rate;
  }
  
  if (billingSettings?.default_hourly_rate) {
    return billingSettings.default_hourly_rate;
  }
  
  return 225;
};

export const validateTimeLogForm = (formData, hourlyRate) => {
  const errors = [];
  
  if (!formData.project_id) {
    errors.push('Please select a project');
  }
  
  const hours = parseFloat(formData.hours);
  if (isNaN(hours) || hours <= 0) {
    errors.push('Hours must be greater than zero');
  }
  
  const rate = parseFloat(hourlyRate);
  if (isNaN(rate) || rate < 0) {
    errors.push('Hourly rate cannot be negative');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};