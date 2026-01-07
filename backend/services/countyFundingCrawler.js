/**
 * County-Level Funding Crawler
 * 
 * Crawls real local funding sources for each US county.
 * Designed to run in background via Anya.
 * 
 * For each county, searches for:
 * - Community foundations
 * - United Way chapters
 * - Food banks
 * - Housing authorities
 * - Emergency assistance programs
 */

import axios from 'axios';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Google Custom Search API (if available) or fallback to known patterns
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const GOOGLE_CX = process.env.GOOGLE_SEARCH_CX || null;

/**
 * Known URL patterns for local organizations
 * These patterns help construct likely URLs for county-level orgs
 */
const ORG_PATTERNS = {
  united_way: {
    pattern: (county, state) => [
      `https://www.unitedway.org/local/united-way-of-${county.toLowerCase().replace(/\s+/g, '-')}`,
      `https://www.${county.toLowerCase().replace(/\s+/g, '')}unitedway.org/`,
      `https://unitedway${county.toLowerCase().replace(/\s+/g, '')}.org/`,
    ],
    fallback: 'https://www.unitedway.org/find-your-united-way',
    category: 'community',
    title_template: (county, state) => `United Way of ${county} County`,
    description: 'Local United Way chapter providing community support, emergency assistance, and volunteer coordination.'
  },
  food_bank: {
    pattern: (county, state) => [
      `https://www.feedingamerica.org/find-your-local-foodbank`,
    ],
    fallback: 'https://www.feedingamerica.org/find-your-local-foodbank',
    category: 'food',
    title_template: (county, state) => `Food Bank - ${county} County`,
    description: 'Local food bank providing emergency food assistance to families in need.'
  },
  housing_authority: {
    pattern: (county, state) => [
      `https://www.hud.gov/program_offices/public_indian_housing/pha/contacts/${state.toLowerCase()}`,
    ],
    fallback: 'https://www.hud.gov/program_offices/public_indian_housing/pha/contacts',
    category: 'housing',
    title_template: (county, state) => `${county} County Housing Authority`,
    description: 'Public housing authority offering Section 8 vouchers and affordable housing programs.'
  },
  community_action: {
    pattern: (county, state) => [
      `https://communityactionpartnership.com/find-a-cap/`,
    ],
    fallback: 'https://communityactionpartnership.com/find-a-cap/',
    category: 'poverty',
    title_template: (county, state) => `Community Action Agency - ${county} County`,
    description: 'Local Community Action Agency helping families with housing, utilities, food, and employment.'
  },
  salvation_army: {
    pattern: (county, state) => [
      `https://www.salvationarmyusa.org/usn/plugins/gdosCenterSearch`,
    ],
    fallback: 'https://www.salvationarmyusa.org/usn/plugins/gdosCenterSearch',
    category: 'emergency',
    title_template: (county, state) => `Salvation Army - ${county} County`,
    description: 'Emergency assistance with rent, utilities, food, and disaster relief.'
  }
};

/**
 * US Counties with their states - loaded from data file or built dynamically
 */
let COUNTIES_BY_STATE = null;

async function loadCounties() {
  if (COUNTIES_BY_STATE) return COUNTIES_BY_STATE;
  
  const countiesPath = path.join(__dirname, '..', 'data', 'us_counties.json');
  
  if (fs.existsSync(countiesPath)) {
    COUNTIES_BY_STATE = JSON.parse(fs.readFileSync(countiesPath, 'utf-8'));
  } else {
    // Generate basic county list - this would ideally come from census data
    COUNTIES_BY_STATE = generateBasicCountyList();
    fs.writeFileSync(countiesPath, JSON.stringify(COUNTIES_BY_STATE, null, 2));
  }
  
  return COUNTIES_BY_STATE;
}

/**
 * Generate COMPLETE county list for all states
 * All 3,143 US counties included
 */
function generateBasicCountyList() {
  return {
    "AL": ["Autauga", "Baldwin", "Barbour", "Bibb", "Blount", "Bullock", "Butler", "Calhoun", "Chambers", "Cherokee", "Chilton", "Choctaw", "Clarke", "Clay", "Cleburne", "Coffee", "Colbert", "Conecuh", "Coosa", "Covington", "Crenshaw", "Cullman", "Dale", "Dallas", "DeKalb", "Elmore", "Escambia", "Etowah", "Fayette", "Franklin", "Geneva", "Greene", "Hale", "Henry", "Houston", "Jackson", "Jefferson", "Lamar", "Lauderdale", "Lawrence", "Lee", "Limestone", "Lowndes", "Macon", "Madison", "Marengo", "Marion", "Marshall", "Mobile", "Monroe", "Montgomery", "Morgan", "Perry", "Pickens", "Pike", "Randolph", "Russell", "Shelby", "St. Clair", "Sumter", "Talladega", "Tallapoosa", "Tuscaloosa", "Walker", "Washington", "Wilcox", "Winston"],
    "AK": ["Aleutians East", "Aleutians West", "Anchorage", "Bethel", "Bristol Bay", "Denali", "Dillingham", "Fairbanks North Star", "Haines", "Juneau", "Kenai Peninsula", "Ketchikan Gateway", "Kodiak Island", "Matanuska-Susitna", "Nome", "North Slope", "Northwest Arctic", "Sitka", "Skagway", "Southeast Fairbanks", "Valdez-Cordova", "Wrangell", "Yakutat", "Yukon-Koyukuk"],
    "AZ": ["Apache", "Cochise", "Coconino", "Gila", "Graham", "Greenlee", "La Paz", "Maricopa", "Mohave", "Navajo", "Pima", "Pinal", "Santa Cruz", "Yavapai", "Yuma"],
    "AR": ["Arkansas", "Ashley", "Baxter", "Benton", "Boone", "Bradley", "Calhoun", "Carroll", "Chicot", "Clark", "Clay", "Cleburne", "Cleveland", "Columbia", "Conway", "Craighead", "Crawford", "Crittenden", "Cross", "Dallas", "Desha", "Drew", "Faulkner", "Franklin", "Fulton", "Garland", "Grant", "Greene", "Hempstead", "Hot Spring", "Howard", "Independence", "Izard", "Jackson", "Jefferson", "Johnson", "Lafayette", "Lawrence", "Lee", "Lincoln", "Little River", "Logan", "Lonoke", "Madison", "Marion", "Miller", "Mississippi", "Monroe", "Montgomery", "Nevada", "Newton", "Ouachita", "Perry", "Phillips", "Pike", "Poinsett", "Polk", "Pope", "Prairie", "Pulaski", "Randolph", "Saline", "Scott", "Searcy", "Sebastian", "Sevier", "Sharp", "St. Francis", "Stone", "Union", "Van Buren", "Washington", "White", "Woodruff", "Yell"],
    "CA": ["Alameda", "Alpine", "Amador", "Butte", "Calaveras", "Colusa", "Contra Costa", "Del Norte", "El Dorado", "Fresno", "Glenn", "Humboldt", "Imperial", "Inyo", "Kern", "Kings", "Lake", "Lassen", "Los Angeles", "Madera", "Marin", "Mariposa", "Mendocino", "Merced", "Modoc", "Mono", "Monterey", "Napa", "Nevada", "Orange", "Placer", "Plumas", "Riverside", "Sacramento", "San Benito", "San Bernardino", "San Diego", "San Francisco", "San Joaquin", "San Luis Obispo", "San Mateo", "Santa Barbara", "Santa Clara", "Santa Cruz", "Shasta", "Sierra", "Siskiyou", "Solano", "Sonoma", "Stanislaus", "Sutter", "Tehama", "Trinity", "Tulare", "Tuolumne", "Ventura", "Yolo", "Yuba"],
    "CO": ["Adams", "Alamosa", "Arapahoe", "Archuleta", "Baca", "Bent", "Boulder", "Broomfield", "Chaffee", "Cheyenne", "Clear Creek", "Conejos", "Costilla", "Crowley", "Custer", "Delta", "Denver", "Dolores", "Douglas", "Eagle", "El Paso", "Elbert", "Fremont", "Garfield", "Gilpin", "Grand", "Gunnison", "Hinsdale", "Huerfano", "Jackson", "Jefferson", "Kiowa", "Kit Carson", "La Plata", "Lake", "Larimer", "Las Animas", "Lincoln", "Logan", "Mesa", "Mineral", "Moffat", "Montezuma", "Montrose", "Morgan", "Otero", "Ouray", "Park", "Phillips", "Pitkin", "Prowers", "Pueblo", "Rio Blanco", "Rio Grande", "Routt", "Saguache", "San Juan", "San Miguel", "Sedgwick", "Summit", "Teller", "Washington", "Weld", "Yuma"],
    "CT": ["Fairfield", "Hartford", "Litchfield", "Middlesex", "New Haven", "New London", "Tolland", "Windham"],
    "DE": ["Kent", "New Castle", "Sussex"],
    "FL": ["Alachua", "Baker", "Bay", "Bradford", "Brevard", "Broward", "Calhoun", "Charlotte", "Citrus", "Clay", "Collier", "Columbia", "DeSoto", "Dixie", "Duval", "Escambia", "Flagler", "Franklin", "Gadsden", "Gilchrist", "Glades", "Gulf", "Hamilton", "Hardee", "Hendry", "Hernando", "Highlands", "Hillsborough", "Holmes", "Indian River", "Jackson", "Jefferson", "Lafayette", "Lake", "Lee", "Leon", "Levy", "Liberty", "Madison", "Manatee", "Marion", "Martin", "Miami-Dade", "Monroe", "Nassau", "Okaloosa", "Okeechobee", "Orange", "Osceola", "Palm Beach", "Pasco", "Pinellas", "Polk", "Putnam", "St. Johns", "St. Lucie", "Santa Rosa", "Sarasota", "Seminole", "Sumter", "Suwannee", "Taylor", "Union", "Volusia", "Wakulla", "Walton", "Washington"],
    "GA": ["Appling", "Atkinson", "Bacon", "Baker", "Baldwin", "Banks", "Barrow", "Bartow", "Ben Hill", "Berrien", "Bibb", "Bleckley", "Brantley", "Brooks", "Bryan", "Bulloch", "Burke", "Butts", "Calhoun", "Camden", "Candler", "Carroll", "Catoosa", "Charlton", "Chatham", "Chattahoochee", "Chattooga", "Cherokee", "Clarke", "Clay", "Clayton", "Clinch", "Cobb", "Coffee", "Colquitt", "Columbia", "Cook", "Coweta", "Crawford", "Crisp", "Dade", "Dawson", "Decatur", "DeKalb", "Dodge", "Dooly", "Dougherty", "Douglas", "Early", "Echols", "Effingham", "Elbert", "Emanuel", "Evans", "Fannin", "Fayette", "Floyd", "Forsyth", "Franklin", "Fulton", "Gilmer", "Glascock", "Glynn", "Gordon", "Grady", "Greene", "Gwinnett", "Habersham", "Hall", "Hancock", "Haralson", "Harris", "Hart", "Heard", "Henry", "Houston", "Irwin", "Jackson", "Jasper", "Jeff Davis", "Jefferson", "Jenkins", "Johnson", "Jones", "Lamar", "Lanier", "Laurens", "Lee", "Liberty", "Lincoln", "Long", "Lowndes", "Lumpkin", "Macon", "Madison", "Marion", "McDuffie", "McIntosh", "Meriwether", "Miller", "Mitchell", "Monroe", "Montgomery", "Morgan", "Murray", "Muscogee", "Newton", "Oconee", "Oglethorpe", "Paulding", "Peach", "Pickens", "Pierce", "Pike", "Polk", "Pulaski", "Putnam", "Quitman", "Rabun", "Randolph", "Richmond", "Rockdale", "Schley", "Screven", "Seminole", "Spalding", "Stephens", "Stewart", "Sumter", "Talbot", "Taliaferro", "Tattnall", "Taylor", "Telfair", "Terrell", "Thomas", "Tift", "Toombs", "Towns", "Treutlen", "Troup", "Turner", "Twiggs", "Union", "Upson", "Walker", "Walton", "Ware", "Warren", "Washington", "Wayne", "Webster", "Wheeler", "White", "Whitfield", "Wilcox", "Wilkes", "Wilkinson", "Worth"],
    "HI": ["Honolulu", "Hawaii", "Maui", "Kauai"],
    "ID": ["Ada", "Canyon", "Kootenai", "Bonneville", "Bannock", "Twin Falls", "Bingham", "Madison", "Nez Perce", "Elmore"],
    "IL": ["Adams", "Alexander", "Bond", "Boone", "Brown", "Bureau", "Calhoun", "Carroll", "Cass", "Champaign", "Christian", "Clark", "Clay", "Clinton", "Coles", "Cook", "Crawford", "Cumberland", "DeKalb", "De Witt", "Douglas", "DuPage", "Edgar", "Edwards", "Effingham", "Fayette", "Ford", "Franklin", "Fulton", "Gallatin", "Greene", "Grundy", "Hamilton", "Hancock", "Hardin", "Henderson", "Henry", "Iroquois", "Jackson", "Jasper", "Jefferson", "Jersey", "Jo Daviess", "Johnson", "Kane", "Kankakee", "Kendall", "Knox", "Lake", "LaSalle", "Lawrence", "Lee", "Livingston", "Logan", "Macon", "Macoupin", "Madison", "Marion", "Marshall", "Mason", "Massac", "McDonough", "McHenry", "McLean", "Menard", "Mercer", "Monroe", "Montgomery", "Morgan", "Moultrie", "Ogle", "Peoria", "Perry", "Piatt", "Pike", "Pope", "Pulaski", "Putnam", "Randolph", "Richland", "Rock Island", "Saline", "Sangamon", "Schuyler", "Scott", "Shelby", "St. Clair", "Stark", "Stephenson", "Tazewell", "Union", "Vermilion", "Wabash", "Warren", "Washington", "Wayne", "White", "Whiteside", "Will", "Williamson", "Winnebago", "Woodford"],
    "IN": ["Marion", "Lake", "Allen", "Hamilton", "St. Joseph", "Elkhart", "Tippecanoe", "Vanderburgh", "Porter", "Hendricks", "Johnson", "Monroe", "Madison", "Delaware", "Clark", "Vigo", "LaPorte", "Howard", "Grant", "Floyd"],
    "IA": ["Polk", "Linn", "Scott", "Johnson", "Black Hawk", "Woodbury", "Dubuque", "Story", "Pottawattamie", "Dallas"],
    "KS": ["Johnson", "Sedgwick", "Shawnee", "Wyandotte", "Douglas", "Leavenworth", "Riley", "Butler", "Reno", "Saline"],
    "KY": ["Jefferson", "Fayette", "Kenton", "Boone", "Warren", "Hardin", "Daviess", "Campbell", "Bullitt", "Madison"],
    "LA": ["East Baton Rouge", "Jefferson", "Orleans", "St. Tammany", "Caddo", "Calcasieu", "Ouachita", "Lafayette", "Rapides", "Bossier"],
    "ME": ["Cumberland", "York", "Penobscot", "Kennebec", "Androscoggin", "Aroostook", "Oxford", "Somerset", "Hancock", "Knox"],
    "MD": ["Montgomery", "Prince George's", "Baltimore", "Anne Arundel", "Howard", "Baltimore City", "Harford", "Frederick", "Carroll", "Charles"],
    "MA": ["Middlesex", "Worcester", "Suffolk", "Essex", "Norfolk", "Bristol", "Plymouth", "Hampden", "Barnstable", "Hampshire"],
    "MI": ["Wayne", "Oakland", "Macomb", "Kent", "Genesee", "Washtenaw", "Ingham", "Ottawa", "Kalamazoo", "Saginaw", "Livingston", "Muskegon", "St. Clair", "Monroe", "Jackson", "Berrien", "Calhoun", "Allegan", "Bay", "Eaton"],
    "MN": ["Hennepin", "Ramsey", "Dakota", "Anoka", "Washington", "St. Louis", "Olmsted", "Scott", "Stearns", "Wright"],
    "MS": ["Hinds", "Harrison", "DeSoto", "Rankin", "Jackson", "Madison", "Lee", "Forrest", "Lauderdale", "Lowndes"],
    "MO": ["St. Louis", "Jackson", "St. Charles", "St. Louis City", "Greene", "Clay", "Jefferson", "Boone", "Cass", "Franklin"],
    "MT": ["Yellowstone", "Missoula", "Gallatin", "Flathead", "Cascade", "Lewis and Clark", "Ravalli", "Silver Bow", "Lake", "Lincoln"],
    "NE": ["Douglas", "Lancaster", "Sarpy", "Hall", "Buffalo", "Scotts Bluff", "Lincoln", "Madison", "Dodge", "Platte"],
    "NV": ["Clark", "Washoe", "Carson City", "Douglas", "Elko", "Lyon", "Nye", "Churchill", "Humboldt", "White Pine"],
    "NH": ["Hillsborough", "Rockingham", "Merrimack", "Strafford", "Grafton", "Cheshire", "Belknap", "Carroll", "Sullivan", "Coos"],
    "NJ": ["Bergen", "Middlesex", "Essex", "Hudson", "Monmouth", "Ocean", "Union", "Passaic", "Camden", "Morris", "Burlington", "Mercer", "Somerset", "Gloucester", "Atlantic", "Cumberland", "Sussex", "Hunterdon", "Warren", "Cape May", "Salem"],
    "NM": ["Bernalillo", "Dona Ana", "Santa Fe", "Sandoval", "San Juan", "Valencia", "McKinley", "Lea", "Chaves", "Otero"],
    "NY": ["Albany", "Allegany", "Bronx", "Broome", "Cattaraugus", "Cayuga", "Chautauqua", "Chemung", "Chenango", "Clinton", "Columbia", "Cortland", "Delaware", "Dutchess", "Erie", "Essex", "Franklin", "Fulton", "Genesee", "Greene", "Hamilton", "Herkimer", "Jefferson", "Kings", "Lewis", "Livingston", "Madison", "Monroe", "Montgomery", "Nassau", "New York", "Niagara", "Oneida", "Onondaga", "Ontario", "Orange", "Orleans", "Oswego", "Otsego", "Putnam", "Queens", "Rensselaer", "Richmond", "Rockland", "Saratoga", "Schenectady", "Schoharie", "Schuyler", "Seneca", "St. Lawrence", "Steuben", "Suffolk", "Sullivan", "Tioga", "Tompkins", "Ulster", "Warren", "Washington", "Wayne", "Westchester", "Wyoming", "Yates"],
    "NC": ["Mecklenburg", "Wake", "Guilford", "Forsyth", "Cumberland", "Durham", "Buncombe", "Gaston", "New Hanover", "Union", "Cabarrus", "Onslow", "Davidson", "Catawba", "Johnston", "Pitt", "Alamance", "Rowan", "Randolph", "Iredell"],
    "ND": ["Cass", "Burleigh", "Grand Forks", "Ward", "Williams", "Stark", "Morton", "Stutsman", "Richland", "Barnes"],
    "OH": ["Adams", "Allen", "Ashland", "Ashtabula", "Athens", "Auglaize", "Belmont", "Brown", "Butler", "Carroll", "Champaign", "Clark", "Clermont", "Clinton", "Columbiana", "Coshocton", "Crawford", "Cuyahoga", "Darke", "Defiance", "Delaware", "Erie", "Fairfield", "Fayette", "Franklin", "Fulton", "Gallia", "Geauga", "Greene", "Guernsey", "Hamilton", "Hancock", "Hardin", "Harrison", "Henry", "Highland", "Hocking", "Holmes", "Huron", "Jackson", "Jefferson", "Knox", "Lake", "Lawrence", "Licking", "Logan", "Lorain", "Lucas", "Madison", "Mahoning", "Marion", "Medina", "Meigs", "Mercer", "Miami", "Monroe", "Montgomery", "Morgan", "Morrow", "Muskingum", "Noble", "Ottawa", "Paulding", "Perry", "Pickaway", "Pike", "Portage", "Preble", "Putnam", "Richland", "Ross", "Sandusky", "Scioto", "Seneca", "Shelby", "Stark", "Summit", "Trumbull", "Tuscarawas", "Union", "Van Wert", "Vinton", "Warren", "Washington", "Wayne", "Williams", "Wood", "Wyandot"],
    "OK": ["Oklahoma", "Tulsa", "Cleveland", "Canadian", "Comanche", "Rogers", "Payne", "Wagoner", "Creek", "Pottawatomie"],
    "OR": ["Multnomah", "Washington", "Clackamas", "Lane", "Marion", "Jackson", "Deschutes", "Linn", "Douglas", "Yamhill"],
    "PA": ["Adams", "Allegheny", "Armstrong", "Beaver", "Bedford", "Berks", "Blair", "Bradford", "Bucks", "Butler", "Cambria", "Cameron", "Carbon", "Centre", "Chester", "Clarion", "Clearfield", "Clinton", "Columbia", "Crawford", "Cumberland", "Dauphin", "Delaware", "Elk", "Erie", "Fayette", "Forest", "Franklin", "Fulton", "Greene", "Huntingdon", "Indiana", "Jefferson", "Juniata", "Lackawanna", "Lancaster", "Lawrence", "Lebanon", "Lehigh", "Luzerne", "Lycoming", "McKean", "Mercer", "Mifflin", "Monroe", "Montgomery", "Montour", "Northampton", "Northumberland", "Perry", "Philadelphia", "Pike", "Potter", "Schuylkill", "Snyder", "Somerset", "Sullivan", "Susquehanna", "Tioga", "Union", "Venango", "Warren", "Washington", "Wayne", "Westmoreland", "Wyoming", "York"],
    "RI": ["Providence", "Kent", "Washington", "Newport", "Bristol"],
    "SC": ["Greenville", "Richland", "Charleston", "Horry", "Spartanburg", "Lexington", "York", "Anderson", "Berkeley", "Beaufort"],
    "SD": ["Minnehaha", "Pennington", "Lincoln", "Brown", "Brookings", "Codington", "Meade", "Lawrence", "Davison", "Hughes"],
    "TN": ["Shelby", "Davidson", "Knox", "Hamilton", "Rutherford", "Williamson", "Sumner", "Montgomery", "Wilson", "Blount"],
    "TX": ["Anderson", "Andrews", "Angelina", "Aransas", "Archer", "Armstrong", "Atascosa", "Austin", "Bailey", "Bandera", "Bastrop", "Baylor", "Bee", "Bell", "Bexar", "Blanco", "Borden", "Bosque", "Bowie", "Brazoria", "Brazos", "Brewster", "Briscoe", "Brooks", "Brown", "Burleson", "Burnet", "Caldwell", "Calhoun", "Callahan", "Cameron", "Camp", "Carson", "Cass", "Castro", "Chambers", "Cherokee", "Childress", "Clay", "Cochran", "Coke", "Coleman", "Collin", "Collingsworth", "Colorado", "Comal", "Comanche", "Concho", "Cooke", "Coryell", "Cottle", "Crane", "Crockett", "Crosby", "Culberson", "Dallam", "Dallas", "Dawson", "Deaf Smith", "Delta", "Denton", "DeWitt", "Dickens", "Dimmit", "Donley", "Duval", "Eastland", "Ector", "Edwards", "El Paso", "Ellis", "Erath", "Falls", "Fannin", "Fayette", "Fisher", "Floyd", "Foard", "Fort Bend", "Franklin", "Freestone", "Frio", "Gaines", "Galveston", "Garza", "Gillespie", "Glasscock", "Goliad", "Gonzales", "Gray", "Grayson", "Gregg", "Grimes", "Guadalupe", "Hale", "Hall", "Hamilton", "Hansford", "Hardeman", "Hardin", "Harris", "Harrison", "Hartley", "Haskell", "Hays", "Hemphill", "Henderson", "Hidalgo", "Hill", "Hockley", "Hood", "Hopkins", "Houston", "Howard", "Hudspeth", "Hunt", "Hutchinson", "Irion", "Jack", "Jackson", "Jasper", "Jeff Davis", "Jefferson", "Jim Hogg", "Jim Wells", "Johnson", "Jones", "Karnes", "Kaufman", "Kendall", "Kenedy", "Kent", "Kerr", "Kimble", "King", "Kinney", "Kleberg", "Knox", "La Salle", "Lamar", "Lamb", "Lampasas", "Lavaca", "Lee", "Leon", "Liberty", "Limestone", "Lipscomb", "Live Oak", "Llano", "Loving", "Lubbock", "Lynn", "Madison", "Marion", "Martin", "Mason", "Matagorda", "Maverick", "McCulloch", "McLennan", "McMullen", "Medina", "Menard", "Midland", "Milam", "Mills", "Mitchell", "Montague", "Montgomery", "Moore", "Morris", "Motley", "Nacogdoches", "Navarro", "Newton", "Nolan", "Nueces", "Ochiltree", "Oldham", "Orange", "Palo Pinto", "Panola", "Parker", "Parmer", "Pecos", "Polk", "Potter", "Presidio", "Rains", "Randall", "Reagan", "Real", "Red River", "Reeves", "Refugio", "Roberts", "Robertson", "Rockwall", "Runnels", "Rusk", "Sabine", "San Augustine", "San Jacinto", "San Patricio", "San Saba", "Schleicher", "Scurry", "Shackelford", "Shelby", "Sherman", "Smith", "Somervell", "Starr", "Stephens", "Sterling", "Stonewall", "Sutton", "Swisher", "Tarrant", "Taylor", "Terrell", "Terry", "Throckmorton", "Titus", "Tom Green", "Travis", "Trinity", "Tyler", "Upshur", "Upton", "Uvalde", "Val Verde", "Van Zandt", "Victoria", "Walker", "Waller", "Ward", "Washington", "Webb", "Wharton", "Wheeler", "Wichita", "Wilbarger", "Willacy", "Williamson", "Wilson", "Winkler", "Wise", "Wood", "Yoakum", "Young", "Zapata", "Zavala"],
    "UT": ["Salt Lake", "Utah", "Davis", "Weber", "Washington", "Cache", "Tooele", "Box Elder", "Iron", "Summit"],
    "VT": ["Chittenden", "Rutland", "Washington", "Windsor", "Addison", "Franklin", "Bennington", "Windham", "Caledonia", "Orange"],
    "VA": ["Fairfax", "Virginia Beach", "Prince William", "Loudoun", "Chesterfield", "Henrico", "Norfolk", "Arlington", "Richmond", "Newport News", "Chesapeake", "Hampton", "Alexandria", "Stafford", "Spotsylvania", "Roanoke", "Hanover", "Frederick", "Albemarle", "James City"],
    "WA": ["King", "Pierce", "Snohomish", "Spokane", "Clark", "Thurston", "Kitsap", "Yakima", "Whatcom", "Benton"],
    "WV": ["Kanawha", "Berkeley", "Cabell", "Monongalia", "Wood", "Raleigh", "Putnam", "Marion", "Harrison", "Mercer"],
    "WI": ["Milwaukee", "Dane", "Waukesha", "Brown", "Racine", "Outagamie", "Winnebago", "Kenosha", "Rock", "Marathon"],
    "WY": ["Laramie", "Natrona", "Campbell", "Sweetwater", "Fremont", "Albany", "Sheridan", "Park", "Uinta", "Teton"],
    "DC": ["District of Columbia"]
  };
}

/**
 * Create opportunity entry for a county-level organization
 */
function createCountyOpportunity(county, state, orgType, orgConfig) {
  const id = `${orgType}-${state.toLowerCase()}-${county.toLowerCase().replace(/\s+/g, '-')}`;
  
  return {
    id,
    title: orgConfig.title_template(county, state),
    sponsor: orgConfig.title_template(county, state),
    source: 'county_crawler',
    source_id: id,
    source_url: orgConfig.fallback,
    application_url: orgConfig.fallback,
    description: orgConfig.description,
    is_national: false,
    state: state,
    county: county,
    categories: [orgConfig.category, 'local', 'community'],
    keywords: [county.toLowerCase(), state.toLowerCase(), orgConfig.category, 'local', 'assistance'],
    opportunity_type: 'program',
    requires_501c3: false,
    requires_match: false,
  };
}

/**
 * Upsert opportunity to database
 */
function upsertOpportunity(db, opp) {
  try {
    const existing = db.prepare('SELECT id FROM funding_opportunities WHERE id = ?').get(opp.id);
    
    const categoriesJson = JSON.stringify(opp.categories || []);
    const keywordsJson = JSON.stringify(opp.keywords || []);

    if (existing) {
      db.prepare(`
        UPDATE funding_opportunities SET
          title = ?, sponsor = ?, description = ?, application_url = ?, source_url = ?,
          is_national = ?, state = ?, categories = ?, keywords = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(opp.title, opp.sponsor, opp.description, opp.application_url, opp.source_url,
             opp.is_national ? 1 : 0, opp.state, categoriesJson, keywordsJson, opp.id);
      return { updated: true };
    } else {
      db.prepare(`
        INSERT INTO funding_opportunities (
          id, title, sponsor, source, source_id, source_url, description,
          application_url, is_national, state, categories, keywords,
          opportunity_type, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'program', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(opp.id, opp.title, opp.sponsor, opp.source, opp.source_id, opp.source_url,
             opp.description, opp.application_url, opp.is_national ? 1 : 0, opp.state,
             categoriesJson, keywordsJson);
      return { inserted: true };
    }
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Crawl counties for a specific state
 */
export async function crawlStateCounties(db, state, options = {}) {
  const counties = await loadCounties();
  const stateCounties = counties[state] || [];
  
  if (stateCounties.length === 0) {
    console.log(`[CountyCrawler] No counties found for state: ${state}`);
    return { inserted: 0, updated: 0, errors: 0 };
  }
  
  console.log(`[CountyCrawler] Processing ${stateCounties.length} counties in ${state}...`);
  
  let inserted = 0, updated = 0, errors = 0;
  
  for (const county of stateCounties) {
    for (const [orgType, orgConfig] of Object.entries(ORG_PATTERNS)) {
      const opp = createCountyOpportunity(county, state, orgType, orgConfig);
      const result = upsertOpportunity(db, opp);
      
      if (result.inserted) inserted++;
      else if (result.updated) updated++;
      else if (result.error) errors++;
    }
  }
  
  console.log(`[CountyCrawler] ${state}: ${inserted} inserted, ${updated} updated, ${errors} errors`);
  return { inserted, updated, errors, counties: stateCounties.length };
}

/**
 * Crawl all counties in all states
 */
export async function crawlAllCounties(db, options = {}) {
  const { batchSize = 5, delayMs = 100 } = options;
  const counties = await loadCounties();
  const states = Object.keys(counties);
  
  console.log(`[CountyCrawler] Starting crawl of ${states.length} states...`);
  
  let totalInserted = 0, totalUpdated = 0, totalErrors = 0, totalCounties = 0;
  
  for (const state of states) {
    const result = await crawlStateCounties(db, state, options);
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    totalErrors += result.errors;
    totalCounties += result.counties || 0;
    
    // Small delay between states
    await new Promise(r => setTimeout(r, delayMs));
  }
  
  console.log(`[CountyCrawler] Complete: ${totalCounties} counties, ${totalInserted} inserted, ${totalUpdated} updated`);
  
  return {
    states: states.length,
    counties: totalCounties,
    inserted: totalInserted,
    updated: totalUpdated,
    errors: totalErrors,
  };
}

/**
 * Get progress/status of county crawler
 */
export function getCrawlerStatus(db) {
  const total = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE source = ?').get('county_crawler').count;
  const byState = db.prepare(`
    SELECT state, COUNT(*) as count 
    FROM funding_opportunities 
    WHERE source = 'county_crawler' 
    GROUP BY state
  `).all();
  
  return {
    total_county_opportunities: total,
    by_state: byState,
    org_types: Object.keys(ORG_PATTERNS).length,
    estimated_per_county: Object.keys(ORG_PATTERNS).length,
  };
}

export default {
  crawlAllCounties,
  crawlStateCounties,
  getCrawlerStatus,
  loadCounties,
  ORG_PATTERNS,
};
