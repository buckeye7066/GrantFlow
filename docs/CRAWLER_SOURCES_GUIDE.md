# Crawler Sources Guide

## Overview

The GrantFlow crawlers have been expanded to include **30+ verified real-world grant sources** across multiple categories. This guide explains the sources, how they're used, and how to extend them further.

## Current Crawler Sources

All sources are defined in `backend/fixtures/crawlers/real_funding_opportunities.json` and include real URLs that users can access directly.

### Federal Grants (9 sources)

**Primary Source:**
- **Grants.gov** - The official entry point for ALL federal grants. Includes opportunities from all federal agencies.

- **Specialized Federal Sources:**
- - **NSF (National Science Foundation)** - STEM research, science, and engineering grants
  - - **NIH (National Institutes of Health)** - Biomedical and behavioral research funding
    - - **USDA (Department of Agriculture)** - Agricultural, rural development, and food-related grants
      - - **DOJ (Department of Justice)** - Law enforcement, criminal justice, and victim assistance
        - - **HUD (Housing & Urban Development)** - Housing, community development, and urban revitalization
          - - **ED (Department of Education)** - K-12, higher education, and adult education grants
            - - **EPA (Environmental Protection Agency)** - Environmental protection and sustainability grants
              - - **SBA (Small Business Administration)** - Small business, entrepreneurship, and startup funding
               
                - **Strategy:** Grants.gov is comprehensive but can be overwhelming. Specialized sources allow targeted searches by field.
               
                - ### Foundation Grants (8 sources)
               
                - **Databases:**
                - - **Candid** - Primary directory of foundations and grantmakers (replaces Foundation Center)
                  - - **Foundation Center** (via Candid) - Advanced search for grants and foundation profiles
                    - - **GuideStar** (via Candid) - Nonprofit directory with funding resources
                     
                      - **Major Foundations:**
                      - - **Bill & Melinda Gates Foundation** - Global health, education, and development ($2B+ annual giving)
                        - - **Ford Foundation** - Social justice and economic opportunity ($600M+ annual giving)
                          - - **Rockefeller Foundation** - Global challenges including health and climate ($300M+ annual giving)
                            - - **Google.org** - Tech-focused philanthropy for nonprofits and social enterprises
                             
                              - **Strategy:** Use Candid/Foundation Center to find foundations by giving focus and geography, then research foundation websites directly.
                             
                              - ### State Programs (3 sources)
                             
                              - - **Economic Development Grants** - Business development and economic growth (varies by state)
                                - - **Workforce Development Grants** - Job training and career development (state labor departments)
                                  - - **Arts Council Grants** - Arts and cultural funding (each state has its own arts agency)
                                   
                                    - **Strategy:** These are highly variable by state. Users should check their specific state's commerce/development/labor/arts agency websites.
                                   
                                    - ### Veteran Assistance (3 sources)
                                   
                                    - - **VA Benefits** - Official Veterans Affairs benefits and assistance programs
                                      - - **Veteran Jobs** - Employment services and job training for veterans
                                        - - **Military and Veteran Nonprofits Directory** - Nonprofits serving veterans with funding
                                         
                                          - **Strategy:** Combine official VA resources with nonprofit support organizations for comprehensive assistance.
                                         
                                          - ### Nonprofit Grants (3 sources)
                                         
                                          - - **Nonprofit Resource Center** (Idealist.org) - Hub for nonprofit funding and resources
                                            - - **GuideStar** - Comprehensive nonprofit database (owned by Candid)
                                              - - **National Council of Nonprofits** - State nonprofit associations and advocacy
                                               
                                                - **Strategy:** These are meta-directories that help nonprofits find grants and training resources.
                                               
                                                - ### Disability Assistance (4 sources)
                                               
                                                - - **Benefits.gov** - Comprehensive government benefits search
                                                  - - **SSA (Social Security Administration)** - SSDI/SSI disability benefits
                                                    - - **Vocational Rehabilitation Services** - Job training and employment support for people with disabilities
                                                      - - **ADA National Network** - Accessibility rights and disability rights resources
                                                       
                                                        - **Strategy:** Use Benefits.gov for comprehensive search, then explore specific programs. Vocational rehabilitation is often underutilized.
                                                       
                                                        - ## Data Structure
                                                       
                                                        - Each source in the JSON follows this structure:
                                                       
                                                        - ```json
                                                          {
                                                            "id": "unique-identifier",
                                                            "title": "Human-readable source name",
                                                            "sponsor": "Organization running this source",
                                                            "description": "What this source offers and how to use it",
                                                            "source_url": "URL where information is found",
                                                            "application_url": "URL to apply or search for grants",
                                                            "state": "nationwide or specific state",
                                                            "categories": ["category1", "category2"],
                                                            "keywords": ["searchable", "keywords", "for", "discovery"],
                                                            "eligibility_bullets": ["Eligibility requirement 1", "Eligibility requirement 2"],
                                                            "requires_501c3": true/false,
                                                            "requires_match": true/false,
                                                            "is_active": true/false,
                                                            "record_origin": "curated_verified"
                                                          }
                                                          ```

                                                          ## How Crawlers Use These Sources

                                                          ### Search Flow

                                                          1. **User searches for grants** in GrantFlow (e.g., "education" or "nonprofits")
                                                          2. 2. **Crawler dispatcher** routes to appropriate crawler based on user profile
                                                             3. 3. **Crawler selects sources** matching user's eligibility and interests
                                                                4. 4. **Sources are searched** using keywords, categories, and eligibility filters
                                                                   5. 5. **Results are returned** with links to the actual funding opportunities
                                                                     
                                                                      6. ### Crawler Categories
                                                                     
                                                                      7. Different crawlers specialize in different sources:
                                                                      8. - **federalCrawler** - Grants.gov and federal agency sources
                                                                         - - **foundationCrawler** - Foundation databases and major foundations
                                                                           - - **localCrawler** - State and local programs (varies by location)
                                                                             - - **veteranCrawler** - Veteran-specific assistance and benefits
                                                                               - - **nonprofitCrawler** - Nonprofit directories and resources
                                                                                 - - **disabilityCrawler** - Disability benefits and assistance programs
                                                                                  
                                                                                   - ## How to Extend the Sources
                                                                                  
                                                                                   - ### Adding a New Source
                                                                                  
                                                                                   - 1. **Identify the source** - Real URL that users can access
                                                                                     2. 2. **Research the source** - What does it offer? Who's eligible? How much does it give?
                                                                                        3. 3. **Add to JSON** - Create entry in appropriate category
                                                                                           4. 4. **Test the URL** - Verify source URL and application URL work
                                                                                              5. 5. **Commit** - Create PR with source addition
                                                                                                
                                                                                                 6. ### Fields to Include
                                                                                                
                                                                                                 7. **Required:**
                                                                                                 8. - `id` - Unique identifier (kebab-case: `my-new-source`)
                                                                                                    - - `title` - Human-friendly name
                                                                                                      - - `source_url` - Where the information is
                                                                                                        - - `categories` - One or more from existing categories
                                                                                                          - - `is_active` - Usually `true` for new sources
                                                                                                           
                                                                                                            - **Recommended:**
                                                                                                            - - `sponsor` - Organization running the source
                                                                                                              - - `description` - 1-2 sentences explaining what/how
                                                                                                                - - `application_url` - Direct link to apply or search
                                                                                                                  - - `keywords` - For search and discovery
                                                                                                                    - - `requires_501c3` - Does nonprofit need 501(c)(3) status?
                                                                                                                     
                                                                                                                      - ### Example Addition
                                                                                                                     
                                                                                                                      - ```json
                                                                                                                        {
                                                                                                                          "id": "macarthur-foundation",
                                                                                                                          "title": "MacArthur Foundation Grants",
                                                                                                                          "sponsor": "MacArthur Foundation",
                                                                                                                          "description": "Support for nonprofits and social entrepreneurs. Funding for impact in various sectors including environment, housing, and health.",
                                                                                                                          "source_url": "https://www.macfound.org/grants/",
                                                                                                                          "application_url": "https://www.macfound.org/grants/",
                                                                                                                          "state": "nationwide",
                                                                                                                          "categories": ["foundation_grants", "environment"],
                                                                                                                          "keywords": ["macarthur", "foundation", "environment", "social impact"],
                                                                                                                          "eligibility_bullets": ["Nonprofits and social enterprises", "Nationwide"],
                                                                                                                          "requires_501c3": true,
                                                                                                                          "requires_match": false,
                                                                                                                          "is_active": true,
                                                                                                                          "record_origin": "curated_verified"
                                                                                                                        }
                                                                                                                        ```
                                                                                                                        
                                                                                                                        ## Important Notes
                                                                                                                        
                                                                                                                        ### Verification
                                                                                                                        
                                                                                                                        All sources in the JSON have been verified as:
                                                                                                                        - **Real** - Active websites with actual grant programs
                                                                                                                        - - **Accessible** - Publicly available (no paywalls required for basic searches)
                                                                                                                          - - **Current** - URLs and programs are active as of creation date
                                                                                                                           
                                                                                                                            - ### Rate Limiting
                                                                                                                           
                                                                                                                            - When crawlers search multiple sources, be mindful of:
                                                                                                                            - - Rate limits on free access tiers
                                                                                                                              - - User-Agent requirements for some sites
                                                                                                                                - - Robots.txt files that restrict automated access
                                                                                                                                  - - Terms of Service for web scraping
                                                                                                                                   
                                                                                                                                    - ### Updates
                                                                                                                                   
                                                                                                                                    - Sources should be reviewed and updated:
                                                                                                                                    - - **Quarterly** - Check if URLs are still active
                                                                                                                                      - - **Annually** - Verify content and eligibility requirements haven't changed
                                                                                                                                        - - **Ad-hoc** - When crawlers report broken links or outdated information
                                                                                                                                         
                                                                                                                                          - ## Related Files
                                                                                                                                         
                                                                                                                                          - - `backend/fixtures/crawlers/real_funding_opportunities.json` - All source definitions
                                                                                                                                            - - `backend/services/crawlers/` - Individual crawler implementations
                                                                                                                                              - - `backend/services/crawlers/crawlerHelpers.js` - Shared utilities
                                                                                                                                                - - `VERIFICATION.md` - How to verify crawler functionality
                                                                                                                                                 
                                                                                                                                                  - ## Future Enhancements
                                                                                                                                                  - 
                                                                                                                                                  Potential improvements to the crawler sources:

1. **API Integration** - Some sources offer APIs (Grants.gov has an API)
2. 2. **Automated Scraping** - For sources without APIs, structured crawling
   3. 3. **Real-time Alerts** - Notify users when new matching grants appear
      4. 4. **Eligibility Matching** - Smart filtering based on user profile
         5. 5. **Funding Trends** - Analysis of what's being funded and by whom
            6. 6. **Historical Data** - Track which users found success with which sources
              
               7. ## Contact & Feedback
              
               8. Found a broken link? Know about a great grant source we're missing?
              
               9. - **File an Issue** - Report broken sources or new source suggestions
                  - - **Submit a PR** - Add verified sources and verify existing ones
                  - **Contribute** - Help expand and maintain the crawler sources
                 
                  - ---

                  **Last Updated:** February 2, 2026
                  **Sources Added:** 30+ verified funding sources across 6 categories
                  **Total Source Coverage:** Federal, Foundation, State, Veteran, Nonprofit, and Disability assistance programs
                  
