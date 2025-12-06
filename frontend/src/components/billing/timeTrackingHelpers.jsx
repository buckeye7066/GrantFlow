export const formatMinutesToHoursMinutes = (minutes) => {
  if (!minutes || minutes === 0) return '0m';
  
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  
  return `${hours}h ${mins}m`;
};