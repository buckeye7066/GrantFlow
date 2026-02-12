/**
 * Validation Rules Engine
 * Enforces student status restrictions and automatically excludes
 * non-student profiles from education-focused grants
 */

class ValidationRulesEngine {
    constructor() {
          this.rules = this.initializeRules();
    }

  /**
     * Initialize validation rules for different grant categories
     */
  initializeRules() {
        return {
                studentStatusRules: {
                          educationKeywords: [
                                      'scholarship',
                                      'student',
                                      'college',
                                      'university',
                                      'education',
                                      'tuition',
                                      'financial aid',
                                      'fafsa',
                                      'pell grant',
                                      'fseog',
                                      'academic',
                                      'enrollment',
                                      'undergrad',
                                      'graduate',
                                      'degree'
                                    ],
                          requiredStatuses: [
                                      'currently_enrolled_full_time',
                                      'currently_enrolled_part_time'
                                    ]
                        }
                };
        }
}

export default ValidationRulesEngine;
